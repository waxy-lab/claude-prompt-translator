import { availability, translateDraft } from './lib/translator.js';
import { codePoints, MAX_SOURCE } from './lib/protected-text.js';
import { TaskGate } from './lib/task-gate.js';
import { DraftStore } from './lib/draft-store.js';
import { draftKey, sameTarget } from './lib/target.js';
import { englishPrompt, boundaryMessage, containsChinese } from './lib/text-boundary.js';
import { AutoReader } from './lib/auto-reader.js';
import { renderReply } from './lib/reply-format.js';

const el = Object.fromEntries([...document.querySelectorAll('[id]')].map(node => [node.id, node]));
const store = new DraftStore(chrome.storage.session);
const gate = new TaskGate();
const empty = () => ({ source: '', output: '', translatedSource: null, language: 'zh', translatedLanguage: null, warnings: [] });
let draft = empty(), target = null, key = null, windowId;
let ready = false, running = false, syncing = false, filling = false, view = 0;
let pending = null, engineCheck = 0, renderedReply = null, renderedOriginal = null;
let workspace = 'ask', replyLanguage = 'zh', originalFormat = 'read', hasReadOnce = false;
let promptError = false, actionError = false;
const message = value => chrome.runtime.sendMessage(value);
const valid = () => !!draft.output.trim() && draft.translatedSource === draft.source && draft.translatedLanguage === draft.language && codePoints(draft.source) <= MAX_SOURCE;
const reader = new AutoReader({
  read: expected => message({ type: 'READ_REPLY', target: expected }),
  onChange: renderReader
});

function renderReader(state = reader.state) {
  el.readStart.disabled = !ready || !target || state.enabled || document.hidden;
  el.readStart.textContent = state.phase === 'error' ? '重试自动阅读' : '开启自动阅读';
  el.readPause.hidden = !state.enabled;
  el.readPause.textContent = state.phase === 'enabling' ? '取消准备' : '暂停并清空译文';
  const indicator = state.enabled ? (state.phase === 'enabling' ? '阅读准备中' : '自动阅读中') : state.phase === 'error' ? '阅读需重试' : hasReadOnce ? '阅读已暂停' : '阅读未开启';
  if (el.readerIndicator.textContent !== indicator) el.readerIndicator.textContent = indicator;
  el.readerIndicator.setAttribute('data-phase', state.enabled ? 'active' : state.phase === 'error' ? 'error' : 'off');
  if (el.readStatus.textContent !== state.message) el.readStatus.textContent = state.message;
  if (renderedReply !== state.translation) {
    try { renderReply(el.replyText, state.translation); } catch { el.replyText.textContent = state.translation; }
    renderedReply = state.translation;
  }
  el.replyText.hidden = !state.translation;
  if (renderedOriginal !== state.original) {
    try { renderReply(el.replyOriginal, state.original); } catch { el.replyOriginal.textContent = state.original; }
    el.replyOriginalText.textContent = state.original;
    el.originalCopyStatus.textContent = '';
    renderedOriginal = state.original;
  }
  if (!state.original) replyLanguage = 'zh';
  el.originalTab.disabled = !state.original;
  el.copyOriginal.disabled = !state.original;
  el.readingEmpty.hidden = !!state.original || !!state.translation;
  el.replyWarnings.textContent = state.warnings.join('\n');
  renderViews();
}

function renderViews() {
  const asking = workspace === 'ask', chinese = replyLanguage === 'zh', formatted = originalFormat === 'read';
  el.askPanel.hidden = !asking; el.readingPanel.hidden = asking;
  for (const [tab, selected] of [[el.askTab, asking], [el.readingTab, !asking], [el.translatedTab, chinese], [el.originalTab, !chinese]]) {
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
  }
  el.translatedPanel.hidden = !chinese; el.replyOriginalBox.hidden = chinese;
  el.replyOriginal.hidden = !formatted; el.replyOriginalText.hidden = formatted; el.originalTextHelp.hidden = formatted;
  el.originalReadMode.setAttribute('aria-pressed', String(formatted)); el.originalTextMode.setAttribute('aria-pressed', String(!formatted));
  updateAttention();
}

function updateAttention() {
  const boundary = containsChinese(draft.output);
  const notice = pending ? 'Claude 中已有草稿，等待你确认是否替换。' : boundary ? '英文预览含汉字或全角字符，请回提问区检查。' : promptError ? el.taskStatus.textContent : actionError ? el.actionStatus.textContent : '';
  const flag = pending ? '待确认' : notice ? '需检查' : running ? '翻译中' : filling ? '核对中' : '';
  el.promptFlag.hidden = !flag; el.promptFlag.textContent = flag;
  el.crossNotice.hidden = !notice || workspace === 'ask'; el.crossStatus.textContent = notice;
}

function switchWorkspace(next, focus = false) {
  workspace = next; renderViews();
  if (focus) (next === 'ask' ? el.askTab : el.readingTab).focus();
}
function switchLanguage(next, focus = false) {
  if (next === 'en' && !reader.state.original) return;
  replyLanguage = next; renderViews();
  if (focus) (next === 'zh' ? el.translatedTab : el.originalTab).focus();
}
function tabKeys(event, current, first, second, change) {
  let next;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = current === first ? second : first;
  else if (event.key === 'Home') next = first;
  else if (event.key === 'End') next = second;
  if (next) { event.preventDefault(); change(next, true); }
}
el.askTab.addEventListener('click', () => switchWorkspace('ask'));
el.readingTab.addEventListener('click', () => switchWorkspace('read'));
el.askTab.addEventListener('keydown', e => tabKeys(e, 'ask', 'ask', 'read', switchWorkspace));
el.readingTab.addEventListener('keydown', e => tabKeys(e, 'read', 'ask', 'read', switchWorkspace));
el.translatedTab.addEventListener('click', () => switchLanguage('zh'));
el.originalTab.addEventListener('click', () => switchLanguage('en'));
el.translatedTab.addEventListener('keydown', e => tabKeys(e, 'zh', 'zh', 'en', switchLanguage));
el.originalTab.addEventListener('keydown', e => tabKeys(e, 'en', 'zh', 'en', switchLanguage));
el.originalReadMode.addEventListener('click', () => { originalFormat = 'read'; renderViews(); });
el.originalTextMode.addEventListener('click', () => { originalFormat = 'text'; renderViews(); });
el.returnPrompt.addEventListener('click', () => {
  switchWorkspace('ask');
  const destination = pending ? el.replace : containsChinese(draft.output) ? el.output : el.askTab;
  destination.focus(); destination.scrollIntoView?.({ block: 'nearest' });
});
el.copyOriginal.addEventListener('click', async () => {
  const original = reader.state.original;
  if (!original) return;
  try { await navigator.clipboard.writeText(original); if (reader.state.original === original) el.originalCopyStatus.textContent = '已复制内部原文文本。'; }
  catch {
    if (reader.state.original !== original) return;
    originalFormat = 'text'; renderViews(); el.replyOriginalText.focus();
    const selection = window.getSelection?.();
    if (selection && document.createRange) { const range = document.createRange(); range.selectNodeContents(el.replyOriginalText); selection.removeAllRanges(); selection.addRange(range); }
    el.originalCopyStatus.textContent = '未允许自动复制，文本已选中，请按 Ctrl+C。';
  }
});

function render() {
  const count = codePoints(draft.source);
  el.count.textContent = `${count.toLocaleString('en-US')} / 12,000`;
  el.count.classList.toggle('over', count > MAX_SOURCE);
  el.source.disabled = el.output.disabled = el.language.disabled = !ready || filling;
  el.translate.disabled = !ready || running || filling || !draft.source.trim() || count > MAX_SOURCE;
  el.cancel.hidden = !running;
  el.fill.disabled = !ready || running || filling || !valid() || !target || containsChinese(draft.output);
  el.copy.disabled = !ready || !draft.output.trim();
  el.clear.disabled = !ready || filling;
  el.replace.disabled = filling;
  el.replaceBox.hidden = !pending;
  el.validity.textContent = draft.output ? (valid() ? '结果有效，请对照中文核对后填入。' : '原文已修改、翻译未完成或上次翻译失败，请重新翻译。旧结果仍可复制。') : '';
  el.warning.textContent = (draft.warnings || []).join('\n');
  el.boundaryStatus.textContent = boundaryMessage(draft.output);
  renderReader();
}

function persist() {
  if (!key || !ready) return;
  store.save(key, draft).catch(() => { el.actionStatus.textContent = '会话草稿保存失败，关闭侧栏可能丢失内容。请先复制需要的文字。'; actionError = true; updateAttention(); });
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
      downloadable: '首次翻译可能需要下载语言包。',
      downloading: 'Chrome 正在准备语言包，可点击翻译等待，或稍后重试。',
      available: '本地语言包可用。点击翻译后开始处理。'
    })[status] || '无法确认本地语言包状态，点击翻译可重试。';
  } catch {
    if (serial === engineCheck) el.engineStatus.textContent = '本地引擎检查失败。草稿已保留，稍后可重新检查。';
  }
}

async function syncTarget() {
  if (syncing || document.hidden || !Number.isInteger(windowId)) return;
  syncing = true;
  try {
    let next = null;
    try { const result = await message({ type: 'TARGET', windowId }); if (result.ok) next = result.target; } catch {}
    const nextKey = next ? draftKey(next) : `scratch:${windowId}`;
    if (key === nextKey && (sameTarget(target, next) || !target && !next)) return;
    reader.stop('目标页面已变化，自动阅读已停止并清空。进入所需会话后点击开启。');
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
    el.source.value = draft.source; el.output.value = draft.output; draft.output = el.output.value; el.language.value = draft.language;
    el.taskStatus.textContent = ''; el.actionStatus.textContent = ''; promptError = actionError = false;
    el.targetStatus.textContent = target ? `当前 Claude ${new URL(target.href).pathname}` :
      '未绑定 Claude。请回到聊天页再点扩展图标。这里的临时草稿不会自动带入其他会话。';
    ready = true; render(); checkEngine();
  } finally { syncing = false; }
}

el.source.addEventListener('input', () => {
  invalidateFill(); cancelTranslation('原文已修改，本次翻译已取消。');
  draft.source = el.source.value;
  // Even editing away and back invalidates the previous translation.
  draft.translatedSource = null;
  promptError = actionError = false;
  el.actionStatus.textContent = ''; render(); persist();
});
el.output.addEventListener('input', () => {
  invalidateFill(); cancelTranslation('你已编辑英文，本次翻译已取消。');
  draft.output = el.output.value; el.actionStatus.textContent = ''; actionError = false; render(); persist();
});
el.language.addEventListener('change', () => {
  invalidateFill(); cancelTranslation('中文类型已变化，本次翻译已取消。');
  draft.language = el.language.value; draft.translatedSource = null;
  promptError = actionError = false;
  render(); persist(); checkEngine();
});
el.check.addEventListener('click', checkEngine);
el.translate.addEventListener('click', async () => {
  if (!ready || running || !draft.source.trim() || codePoints(draft.source) > MAX_SOURCE) return;
  invalidateFill();
  promptError = actionError = false;
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
    el.output.value = draft.output; draft.output = el.output.value; el.taskStatus.textContent = '翻译完成，请检查英文含义。'; persist(); checkEngine();
  } catch (error) {
    if (task.current()) { el.taskStatus.textContent = error.message; promptError = true; }
  } finally {
    if (task.current()) { running = false; render(); persist(); }
  }
});
el.cancel.addEventListener('click', () => { cancelTranslation('已取消；迟到的结果不会写回。'); render(); persist(); });
el.clear.addEventListener('click', () => {
  reader.stop('已清空回复内存并暂停自动阅读。');
  invalidateFill(); cancelTranslation(''); draft = empty();
  el.source.value = ''; el.output.value = ''; el.language.value = 'zh';
  el.taskStatus.textContent = ''; el.actionStatus.textContent = '当前页面的会话草稿已清空。';
  promptError = actionError = false;
  store.clear(key).catch(() => { el.actionStatus.textContent = '删除会话草稿失败，请重试。'; actionError = true; updateAttention(); });
  render(); checkEngine();
});
el.copy.addEventListener('click', async () => {
  const at = view;
  try { await navigator.clipboard.writeText(draft.output); if (at === view) { el.actionStatus.textContent = '英文已复制，请自行粘贴并发送。'; actionError = false; updateAttention(); } }
  catch { if (at === view) { el.output.focus(); el.output.select(); el.actionStatus.textContent = 'Chrome 未允许复制，英文已选中，请按 Ctrl+C。'; actionError = true; updateAttention(); } }
});

async function commit(prepared, replace) {
  const at = view, expected = target;
  if (!valid() || !expected) return;
  let text;
  try { text = englishPrompt(draft.output); } catch (error) { invalidateFill(); el.actionStatus.textContent = error.message; render(); return; }
  filling = true; render();
  try {
    const result = await message({ type: 'COMMIT', target: expected, token: prepared.token, replace, text });
    if (at !== view) return;
    pending = null;
    el.actionStatus.textContent = result.ok ? '已填入 Claude，请到网页检查并手动发送。' : result.message;
    actionError = !result.ok;
  } catch { if (at === view) { pending = null; el.actionStatus.textContent = '填入结果未知，请检查网页输入框，不会自动重试。'; actionError = true; } }
  finally { filling = false; render(); }
}

el.fill.addEventListener('click', async () => {
  if (!valid() || !target || running || filling) return;
  try { englishPrompt(draft.output); } catch (error) { el.actionStatus.textContent = error.message; render(); return; }
  invalidateFill();
  const at = view, expected = target;
  actionError = false;
  filling = true; render(); el.actionStatus.textContent = '正在核对页面与输入框…';
  try {
    const result = await message({ type: 'PREPARE', target: expected });
    if (at !== view) return;
    if (!result.ok) { el.actionStatus.textContent = result.message; actionError = true; return; }
    if (result.nonempty) {
      pending = result; el.actionStatus.textContent = '需要明确确认后才替换网页现有草稿。';
    } else { await commit(result, false); }
  } catch { if (at === view) { el.actionStatus.textContent = '无法核对当前页面，请复制英文或回 Claude 再点扩展图标。'; actionError = true; } }
  finally { filling = false; render(); }
});
el.replace.addEventListener('click', () => { if (pending && !filling) commit(pending, true); });
el.keep.addEventListener('click', () => { invalidateFill(); el.actionStatus.textContent = '已取消替换，网页草稿未改动。'; actionError = false; render(); });

el.readStart.addEventListener('click', () => {
  if (!ready || !target || document.hidden || reader.state.enabled) return;
  hasReadOnce = true;
  // No awaited target check before enable: Translator.create retains the click gesture.
  return reader.enable(target);
});
el.readPause.addEventListener('click', () => { reader.stop(); if (!el.readStart.disabled) el.readStart.focus(); });
chrome.tabs.onActivated.addListener(info => {
  if (info.windowId !== undefined && info.windowId !== windowId) return;
  reader.stop('活动标签页已变化，自动阅读已停止并清空。'); syncTarget();
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (id === target?.tabId && (change.url || change.status === 'loading')) reader.stop('页面导航，自动阅读已停止并清空。');
  if (change.url || change.status) syncTarget();
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (target?.tabId === tabId) {
    reader.stop('标签页已关闭，自动阅读已停止并清空。');
    ready = false; invalidateFill(); cancelTranslation('标签页已关闭。'); render();
  }
  // Queue after this panel's earlier writes so closed-tab data cannot be resurrected by them.
  store.clearTab(tabId).catch(() => {});
  syncTarget();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { reader.stop('侧栏已隐藏，自动阅读已停止并清空。回来后点击重新开启。'); cancelTranslation('侧栏已隐藏，翻译已取消。'); render(); }
  else { syncTarget(); renderReader(); }
});
window.addEventListener('pagehide', () => { gate.cancel(); reader.stop(); });
setInterval(async () => { if (!document.hidden) { await syncTarget(); if (!document.hidden) await reader.poll(); } }, 1500);
chrome.windows.getCurrent().then(win => { windowId = win.id; return syncTarget(); }).catch(() => {
  el.targetStatus.textContent = '无法确定浏览器窗口，请关闭侧栏后从工具栏重新打开。';
});
