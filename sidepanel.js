import { availability, translateDraft } from './lib/translator.js';
import { codePoints, MAX_SOURCE } from './lib/protected-text.js';
import { TaskGate } from './lib/task-gate.js';
import { DraftStore } from './lib/draft-store.js';
import { draftKey, sameTarget } from './lib/target.js';

const el = Object.fromEntries([...document.querySelectorAll('[id]')].map(node => [node.id, node]));
const store = new DraftStore(chrome.storage.session);
const gate = new TaskGate();
const empty = () => ({ source: '', output: '', translatedSource: null, language: 'zh', translatedLanguage: null, warnings: [] });
let draft = empty(), target = null, key = null, windowId;
let ready = false, running = false, syncing = false, filling = false, view = 0;
let pending = null, engineCheck = 0;
const message = value => chrome.runtime.sendMessage(value);
const valid = () => !!draft.output.trim() && draft.translatedSource === draft.source && draft.translatedLanguage === draft.language && codePoints(draft.source) <= MAX_SOURCE;

function render() {
  const count = codePoints(draft.source);
  el.count.textContent = `${count.toLocaleString('en-US')} / 12,000`;
  el.count.classList.toggle('over', count > MAX_SOURCE);
  el.source.disabled = el.output.disabled = el.language.disabled = !ready || filling;
  el.translate.disabled = !ready || running || filling || !draft.source.trim() || count > MAX_SOURCE;
  el.cancel.hidden = !running;
  el.fill.disabled = !ready || running || filling || !valid() || !target;
  el.copy.disabled = !ready || !draft.output.trim();
  el.clear.disabled = !ready || filling;
  el.replace.disabled = filling;
  el.replaceBox.hidden = !pending;
  el.validity.textContent = draft.output ? (valid() ? '结果有效，请对照中文核对后填入。' : '原文已修改、翻译未完成或上次翻译失败，请重新翻译。旧结果仍可复制。') : '';
  el.warning.textContent = (draft.warnings || []).join('\n');
}

function persist() {
  if (!key || !ready) return;
  store.save(key, draft).catch(() => { el.actionStatus.textContent = '会话草稿保存失败，关闭侧栏可能丢失内容。请先复制需要的文字。'; });
}

function invalidateFill() {
  view++;
  if (pending && target) message({ type: 'CANCEL_FILL', target }).catch(() => {});
  pending = null;
}

function cancelTranslation(status) {
  gate.cancel();
  if (running) { running = false; el.taskStatus.textContent = status; }
}

async function checkEngine() {
  const serial = ++engineCheck, language = draft.language;
  el.engineStatus.textContent = '正在检查本地引擎…';
  try {
    const status = await availability(language);
    if (serial !== engineCheck) return;
    el.engineStatus.textContent = ({
      missing: '此浏览器没有 Translator API。中文草稿仍可保留；尚不能自动翻译。',
      unavailable: '本机暂不可用所选语言包。可以重新检查或更换中文类型。',
      downloadable: '需要语言包；点击翻译后由 Chrome 下载，首次使用可能较慢。',
      downloading: 'Chrome 正在准备语言包，可点击翻译等待，或稍后重试。',
      available: '本地语言包可用。点击翻译后开始处理。'
    })[status] || '无法确认本地语言包状态，点击翻译可重试。';
  } catch {
    if (serial === engineCheck) el.engineStatus.textContent = '本地引擎检查失败。草稿已保留，稍后可重新检查。';
  }
}

async function syncTarget() {
  if (syncing || !Number.isInteger(windowId)) return;
  syncing = true;
  try {
    let next = null;
    try { const result = await message({ type: 'TARGET', windowId }); if (result.ok) next = result.target; } catch {}
    const nextKey = next ? draftKey(next) : `scratch:${windowId}`;
    if (key === nextKey && (sameTarget(target, next) || !target && !next)) return;
    invalidateFill();
    cancelTranslation('目标页面已变化，本次翻译已取消。');
    ready = false; render();
    target = next; key = nextKey;
    const restoringView = view;
    let saved;
    try { saved = await store.read(key); } catch { el.actionStatus.textContent = '无法恢复会话草稿。'; }
    if (restoringView !== view) return;
    draft = saved && typeof saved.source === 'string' && typeof saved.output === 'string' ? { ...empty(), ...saved } : empty();
    if (!['zh', 'zh-Hant'].includes(draft.language)) draft.language = 'zh';
    el.source.value = draft.source; el.output.value = draft.output; el.language.value = draft.language;
    el.taskStatus.textContent = ''; el.actionStatus.textContent = '';
    el.targetStatus.textContent = target ? `目标：当前 Claude 页面 ${new URL(target.href).pathname} · 草稿按标签页和页面隔离` :
      '未绑定 Claude。请回到聊天页再点扩展图标。这里的临时草稿不会自动带入其他会话。';
    ready = true; render(); checkEngine();
  } finally { syncing = false; }
}

el.source.addEventListener('input', () => {
  invalidateFill(); cancelTranslation('原文已修改，本次翻译已取消。');
  draft.source = el.source.value;
  // Even editing away and back invalidates the previous translation.
  draft.translatedSource = null;
  el.actionStatus.textContent = ''; render(); persist();
});
el.output.addEventListener('input', () => {
  invalidateFill(); cancelTranslation('你已编辑英文，本次翻译已取消。');
  draft.output = el.output.value; el.actionStatus.textContent = ''; render(); persist();
});
el.language.addEventListener('change', () => {
  invalidateFill(); cancelTranslation('中文类型已变化，本次翻译已取消。');
  draft.language = el.language.value; draft.translatedSource = null;
  render(); persist(); checkEngine();
});
el.check.addEventListener('click', checkEngine);
el.translate.addEventListener('click', async () => {
  if (!ready || running || !draft.source.trim() || codePoints(draft.source) > MAX_SOURCE) return;
  invalidateFill();
  const task = gate.begin(), source = draft.source, language = draft.language;
  // An earlier visible result must not remain insertable if this attempt fails.
  draft.translatedSource = null;
  running = true; el.taskStatus.textContent = '正在准备本地引擎并翻译…'; el.actionStatus.textContent = ''; render(); persist();
  try {
    const result = await translateDraft(source, language, {
      signal: task.signal,
      onProgress(percent) { if (task.current()) el.taskStatus.textContent = `Chrome 语言包准备进度 ${percent}%（首次使用需要下载）`; }
    });
    if (!task.current()) return;
    draft.output = result.text; draft.translatedSource = source; draft.translatedLanguage = language; draft.warnings = result.warnings;
    el.output.value = draft.output; el.taskStatus.textContent = '翻译完成，请检查英文含义。'; persist(); checkEngine();
  } catch (error) {
    if (task.current()) el.taskStatus.textContent = error.message;
  } finally {
    if (task.current()) { running = false; render(); persist(); }
  }
});
el.cancel.addEventListener('click', () => { cancelTranslation('已取消；迟到的结果不会写回。'); render(); persist(); });
el.clear.addEventListener('click', () => {
  invalidateFill(); cancelTranslation(''); draft = empty();
  el.source.value = ''; el.output.value = ''; el.language.value = 'zh';
  el.taskStatus.textContent = ''; el.actionStatus.textContent = '当前页面的会话草稿已清空。';
  store.clear(key).catch(() => { el.actionStatus.textContent = '删除会话草稿失败，请重试。'; });
  render(); checkEngine();
});
el.copy.addEventListener('click', async () => {
  const at = view;
  try { await navigator.clipboard.writeText(draft.output); if (at === view) el.actionStatus.textContent = '英文已复制，请自行粘贴并发送。'; }
  catch { if (at === view) { el.output.focus(); el.output.select(); el.actionStatus.textContent = 'Chrome 未允许复制，英文已选中，请按 Ctrl+C。'; } }
});

async function commit(prepared, replace) {
  const at = view, expected = target, text = draft.output.replace(/\r\n?/g, '\n');
  if (!valid() || !expected) return;
  filling = true; render();
  try {
    const result = await message({ type: 'COMMIT', target: expected, token: prepared.token, replace, text });
    if (at !== view) return;
    pending = null;
    el.actionStatus.textContent = result.ok ? '已填入 Claude，请到网页检查并手动发送。' : result.message;
  } catch { if (at === view) { pending = null; el.actionStatus.textContent = '填入结果未知，请检查网页输入框，不会自动重试。'; } }
  finally { filling = false; render(); }
}

el.fill.addEventListener('click', async () => {
  if (!valid() || !target || running || filling) return;
  invalidateFill();
  const at = view, expected = target;
  filling = true; render(); el.actionStatus.textContent = '正在核对页面与输入框…';
  try {
    const result = await message({ type: 'PREPARE', target: expected });
    if (at !== view) return;
    if (!result.ok) { el.actionStatus.textContent = result.message; return; }
    if (result.nonempty) {
      pending = result; el.actionStatus.textContent = '需要明确确认后才替换网页现有草稿。';
    } else { await commit(result, false); }
  } catch { if (at === view) el.actionStatus.textContent = '无法核对当前页面，请复制英文或回 Claude 再点扩展图标。'; }
  finally { filling = false; render(); }
});
el.replace.addEventListener('click', () => { if (pending && !filling) commit(pending, true); });
el.keep.addEventListener('click', () => { invalidateFill(); el.actionStatus.textContent = '已取消替换，网页草稿未改动。'; render(); });

chrome.tabs.onActivated.addListener(syncTarget);
chrome.tabs.onUpdated.addListener((_id, change) => { if (change.url || change.status) syncTarget(); });
chrome.tabs.onRemoved.addListener(tabId => {
  if (target?.tabId === tabId) {
    ready = false; invalidateFill(); cancelTranslation('标签页已关闭。'); render();
  }
  // Queue after this panel's earlier writes so closed-tab data cannot be resurrected by them.
  store.clearTab(tabId).catch(() => {});
  syncTarget();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncTarget(); });
window.addEventListener('pagehide', () => { gate.cancel(); });
setInterval(() => { if (!document.hidden) syncTarget(); }, 1500);
chrome.windows.getCurrent().then(win => { windowId = win.id; return syncTarget(); }).catch(() => {
  el.targetStatus.textContent = '无法确定浏览器窗口，请关闭侧栏后从工具栏重新打开。';
});
