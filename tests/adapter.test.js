import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { claudeAdapter } from '../content/claude-adapter.js';
import { captureIdentity } from '../lib/target.js';

// Simulated DOM. This checks the write protocol; it does NOT simulate React/ProseMirror internals.
function fixture(t, { value = '', textarea = false } = {}) {
  let selected, writes = 0, now = 0, commandWorks = true;
  const timers = new Set(), observers = [];
  const form = { busy: false, getAttribute: () => form.busy ? 'true' : null };
  class TextArea {
    constructor() { this._value = value; this.innerText = value; this.textContent = value; this.isConnected = true; this.isContentEditable = true; this.tagName = textarea ? 'TEXTAREA' : 'DIV'; this.events = new Map(); this.show = true; this.inForm = true; }
    get value() { return this._value; } set value(v) { this._value = v; }
    getClientRects() { return this.show ? [{}] : []; }
    closest(selector) {
      if ((selector === 'form' || selector === 'form, fieldset') && this.inForm) return form;
      if (selector.includes('dialog') && this.excluded) return {};
      return null;
    }
    getAttribute(name) { return name === 'aria-disabled' && this.disabled ? 'true' : null; }
    querySelector() { return null; }
    focus() { this.onFocus?.(); }
    addEventListener(name, fn) { this.events.set(name, fn); }
    removeEventListener(name) { this.events.delete(name); }
    dispatchEvent(event) { this.events.get(event.type)?.(event); return true; }
  }
  const el = new TextArea();
  const context = vm.createContext({
    crypto: { randomUUID: () => `token-${Math.random()}` },
    location: { origin: 'https://claude.ai', href: 'https://claude.ai/chat/a' },
    __claudeEnglishAssistantIdentityV1: { nonce: 'nonce', revision: 0 },
    Date: { now: () => now },
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; }, clearTimeout,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    getSelection: () => ({ removeAllRanges() {}, addRange(range) { selected = range.el; } }),
    HTMLTextAreaElement: TextArea,
    InputEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    MutationObserver: class {
      constructor(fn) { this.fn = fn; this.records = []; observers.push(this); }
      observe() {} disconnect() {} takeRecords() { return this.records.splice(0); }
    }
  });
  context.document = {
    visibilityState: 'visible', editors: [el], stop: false,
    querySelectorAll(selector) { return selector.includes('contenteditable') ? this.editors : this.stop ? [el] : []; },
    createRange: () => ({ selectNodeContents(node) { this.el = node; } }),
    execCommand(command, ui, text) {
      assert.equal(command, 'insertText'); assert.equal(ui, false);
      writes++;
      if (commandWorks) { selected.innerText = text; selected.textContent = text; }
      return commandWorks;
    }
  };
  const run = vm.runInContext(`(${claudeAdapter.toString()})`, context);
  const expected = { href: context.location.href, nonce: 'nonce', revision: 0 };
  const call = options => run({ expected, ...options });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  return { el, context, form, call, observers, TextArea, get writes() { return writes; }, setNow(value) { now = value; }, failCommand() { commandWorks = false; } };
}

test('空编辑器写入纯文本，不返回网页原文、不产生发送操作', async t => {
  const f = fixture(t);
  const prepared = await f.call({ mode: 'prepare' });
  assert.deepEqual(Object.keys(prepared).sort(), ['nonempty', 'ok', 'token']);
  assert.equal(prepared.nonempty, false);
  const result = await f.call({ mode: 'commit', token: prepared.token, text: '<script>alert(1)</script>\nEnglish' });
  assert.equal(result.ok, true); assert.equal(f.writes, 1);
  assert.equal(f.el.innerText, '<script>alert(1)</script>\nEnglish');
});

test('非空草稿必须显式 replace=true', async t => {
  const f = fixture(t, { value: 'existing private text' });
  const prepared = await f.call({ mode: 'prepare' });
  assert.equal(prepared.nonempty, true);
  assert.ok(!JSON.stringify(prepared).includes('private'));
  const result = await f.call({ mode: 'commit', token: prepared.token, text: 'English' });
  assert.equal(result.code, 'DRAFT_CHANGED'); assert.equal(f.writes, 0);
  assert.equal(f.el.innerText, 'existing private text');
});

test('明确确认可替换，令牌只能使用一次', async t => {
  const f = fixture(t, { value: 'old' });
  const prepared = await f.call({ mode: 'prepare' });
  const request = { mode: 'commit', token: prepared.token, replace: true, text: 'new' };
  assert.equal((await f.call(request)).ok, true);
  assert.equal((await f.call(request)).code, 'EXPIRED'); assert.equal(f.writes, 1);
});

test('确认后改动又改回，以及尚未派发的 DOM 变化均阻止覆盖', async t => {
  const f = fixture(t, { value: 'old' });
  let p = await f.call({ mode: 'prepare' });
  f.el.dispatchEvent({ type: 'input' });
  assert.equal((await f.call({ mode: 'commit', token: p.token, replace: true, text: 'new' })).code, 'DRAFT_CHANGED');
  p = await f.call({ mode: 'prepare' });
  f.observers.at(-1).records.push({ type: 'characterData' });
  assert.equal((await f.call({ mode: 'commit', token: p.token, replace: true, text: 'new' })).code, 'DRAFT_CHANGED');
  assert.equal(f.writes, 0);
});

test('聚焦处理器更改草稿时停止写入', async t => {
  const f = fixture(t);
  const p = await f.call({ mode: 'prepare' });
  f.el.onFocus = () => { f.el.innerText = 'user typed'; f.el.textContent = 'user typed'; };
  const result = await f.call({ mode: 'commit', token: p.token, text: 'new' });
  assert.equal(result.code, 'DRAFT_CHANGED'); assert.equal(f.writes, 0);
});

test('会话导航、导航返回、后台标签页与错误文档身份停止操作', async t => {
  for (const change of [
    f => { f.context.location.href = 'https://claude.ai/chat/b'; },
    f => { f.context.__claudeEnglishAssistantIdentityV1.revision++; },
    f => { f.context.__claudeEnglishAssistantIdentityV1.nonce = 'other'; },
    f => { f.context.document.visibilityState = 'hidden'; }
  ]) {
    const f = fixture(t); const p = await f.call({ mode: 'prepare' }); change(f);
    assert.equal((await f.call({ mode: 'commit', token: p.token, text: 'new' })).code, 'TARGET_CHANGED');
    assert.equal(f.writes, 0);
  }
});

test('多个候选、被排除的编辑区、只读与生成中不写入', async t => {
  for (const [change, code] of [
    [f => f.context.document.editors.push(new f.TextArea()), 'EDITOR_AMBIGUOUS'],
    [f => { f.el.excluded = true; }, 'EDITOR_AMBIGUOUS'],
    [f => { f.el.disabled = true; }, 'EDITOR_BUSY'],
    [f => { f.form.busy = true; }, 'EDITOR_BUSY'],
    [f => { f.context.document.stop = true; }, 'EDITOR_BUSY']
  ]) { const f = fixture(t); change(f); assert.equal((await f.call({ mode: 'prepare' })).code, code); assert.equal(f.writes, 0); }
});

test('带明确编辑器标识但不在 form 中也可按两阶段写入', async t => {
  const f = fixture(t); f.el.inForm = false;
  const p = await f.call({ mode: 'prepare' });
  assert.equal(p.ok, true);
  assert.equal((await f.call({ mode: 'commit', token: p.token, text: 'English' })).ok, true);
  assert.equal(f.writes, 1);
});

test('无匹配和多匹配的提示不同，诊断不包含网页文本', async t => {
  const f = fixture(t, { value: 'private text' }); f.el.excluded = true;
  const missing = await f.call({ mode: 'prepare' });
  assert.match(missing.message, /匹配 0/); assert.ok(!missing.message.includes('private'));
  f.el.excluded = false; f.context.document.editors.push(new f.TextArea());
  assert.match((await f.call({ mode: 'prepare' })).message, /2 个可用编辑器/);
  assert.equal(f.writes, 0);
});

test('编辑器被替换、令牌过期与取消均阻止旧请求', async t => {
  const f = fixture(t);
  let p = await f.call({ mode: 'prepare' }); f.el.isConnected = false;
  f.context.document.editors = [new f.TextArea()];
  assert.equal((await f.call({ mode: 'commit', token: p.token, text: 'new' })).code, 'DRAFT_CHANGED');
  p = await f.call({ mode: 'prepare' }); f.setNow(61000);
  assert.equal((await f.call({ mode: 'commit', token: p.token, text: 'new' })).code, 'EXPIRED');
  p = await f.call({ mode: 'prepare' }); await f.call({ mode: 'cancel' });
  assert.equal((await f.call({ mode: 'commit', token: p.token, text: 'new' })).code, 'EXPIRED');
  assert.equal(f.writes, 0);
});

test('写入无法确认时报告未知，不重复写入或回滚', async t => {
  const f = fixture(t); f.failCommand();
  const p = await f.call({ mode: 'prepare' });
  assert.equal((await f.call({ mode: 'commit', token: p.token, text: 'new' })).code, 'UNCONFIRMED');
  assert.equal(f.writes, 1);
});

test('textarea 使用原生 setter 和 input 事件', async t => {
  const f = fixture(t, { textarea: true, value: 'old' });
  const p = await f.call({ mode: 'prepare' });
  const result = await f.call({ mode: 'commit', token: p.token, replace: true, text: 'new\nline' });
  assert.equal(result.ok, true); assert.equal(f.el.value, 'new\nline'); assert.equal(f.writes, 0);
});

test('页面写入最后一道边界拒绝汉字和全角，不修改受保护代码', async t => {
  for (const text of ['English 中文', 'Ｈｅｌｌｏ', '`// 中文`', 'https://a.test/中文', '￥5']) {
    const f = fixture(t); const p = await f.call({ mode: 'prepare' });
    assert.equal((await f.call({ mode: 'commit', token: p.token, text })).code, 'CHINESE_BOUNDARY');
    assert.equal(f.writes, 0); assert.equal(f.el.innerText, '');
  }
});

test('页面身份探针不读取编辑器，导航事件提升版本', () => {
  const listeners = new Map();
  const ctx = vm.createContext({
    location: { origin: 'https://claude.ai', href: 'https://claude.ai/new' },
    document: { visibilityState: 'visible' }, crypto: { randomUUID: () => 'nonce' },
    navigation: { addEventListener: (name, fn) => listeners.set(name, fn) },
    addEventListener: (name, fn) => listeners.set(name, fn)
  });
  const run = vm.runInContext(`(${captureIdentity.toString()})`, ctx);
  assert.equal(run().revision, 0); listeners.get('navigate')(); assert.equal(run().revision, 1);
  assert.equal(run().nonce, 'nonce');
  ctx.document.visibilityState = 'hidden'; assert.equal(run(), null);
});
