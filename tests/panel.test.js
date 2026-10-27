import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('侧栏集成：取消、过期结果、清空、恢复、多页隔离和明确替换', async t => {
  const originalInterval = globalThis.setInterval;
  const originalNow = Date.now;
  let time = 0; Date.now = () => time;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const hooks = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
  const html = await fs.readFile(new URL('../sidepanel.html', import.meta.url), 'utf8');
  const nodes = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    id, value: '', textContent: '', disabled: false, hidden: false, dataset: {},
    classList: { toggle() {} }, handlers: {}, attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    async trigger(name) { if (name === 'click' && this.disabled) return; return this.handlers[name]?.(); },
    focus() { globalThis.document.activeElement = this; }, select() {}
  }]));
  let poll;
  globalThis.setInterval = fn => { poll = fn; return 1; };
  const memory = {}, requests = [];
  let target = { tabId: 1, windowId: 8, href: 'https://claude.ai/chat/a', documentId: 'doc1', nonce: 'nonce', revision: 0 };
  let nonempty = false, reply = null;
  globalThis.document = { hidden: false, handlers: {}, querySelectorAll: () => Object.values(nodes), addEventListener(name, fn) { this.handlers[name] = fn; } };
  globalThis.window = { addEventListener() {} };
  globalThis.chrome = {
    storage: { session: {
      async get(key) { return key === null ? structuredClone(memory) : { [key]: memory[key] && structuredClone(memory[key]) }; },
      async set(value) { Object.assign(memory, structuredClone(value)); },
      async remove(key) { for (const item of Array.isArray(key) ? key : [key]) delete memory[item]; }
    } },
    tabs: { onActivated: hooks(), onUpdated: hooks(), onRemoved: hooks() }, windows: { getCurrent: async () => ({ id: 8 }) },
    runtime: { async sendMessage(request) {
      requests.push(structuredClone(request));
      if (request.type === 'TARGET') return { ok: true, target: structuredClone(target) };
      if (request.type === 'PREPARE') return { ok: true, token: 'one-use', nonempty };
      if (request.type === 'READ_REPLY') return { ok: true, reply: structuredClone(reply) };
      return { ok: true };
    } }
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => {} } } });
  globalThis.Translator = { availability: async () => 'available', create: async () => ({ translate: async () => 'English result', destroy() {} }) };
  t.after(() => {
    globalThis.setInterval = originalInterval;
    Date.now = originalNow;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    delete globalThis.chrome; delete globalThis.document; delete globalThis.window; delete globalThis.Translator;
  });
  const tick = () => new Promise(resolve => setTimeout(resolve, 8));
  const input = async (id, value) => { nodes[id].value = value; await nodes[id].trigger('input'); };
  await import('../sidepanel.js'); await tick();
  assert.equal(nodes.source.disabled, false);
  assert.equal(nodes.askPanel.hidden, false); assert.equal(nodes.readingPanel.hidden, true);
  await nodes.readingTab.trigger('click'); assert.equal(nodes.askPanel.hidden, true);
  await nodes.askTab.trigger('click'); assert.equal(nodes.askTab.getAttribute('aria-selected'), 'true');
  await input('source', '中文'); await nodes.translate.trigger('click');
  assert.equal(nodes.output.value, 'English result'); assert.equal(nodes.fill.disabled, false);
  await input('output', 'Edited English'); assert.equal(nodes.fill.disabled, false);
  await input('source', '修改'); assert.equal(nodes.fill.disabled, true);
  await input('source', '中文'); assert.equal(nodes.fill.disabled, true, 'editing away and back stays stale');

  let finish, started;
  const begun = new Promise(resolve => { started = resolve; });
  globalThis.Translator.create = async () => ({ translate() { started(); return new Promise(resolve => { finish = resolve; }); }, destroy() {} });
  const translating = nodes.translate.trigger('click'); await begun;
  await input('source', '新原文'); finish('obsolete'); await translating;
  assert.equal(nodes.output.value, 'Edited English'); assert.equal(nodes.fill.disabled, true);
  const begunAgain = new Promise(resolve => { started = resolve; });
  const cancelled = nodes.translate.trigger('click'); await begunAgain;
  await nodes.cancel.trigger('click'); finish('cancelled'); await cancelled;
  assert.equal(nodes.output.value, 'Edited English');
  const begunClear = new Promise(resolve => { started = resolve; });
  const clearing = nodes.translate.trigger('click'); await begunClear;
  await nodes.clear.trigger('click'); finish('late after clear'); await clearing; await tick();
  assert.equal(nodes.output.value, ''); assert.equal(nodes.source.value, '');
  assert.equal(memory['draft:1:https://claude.ai/chat/a'], undefined);

  globalThis.Translator.create = async () => ({ translate: async () => 'Fresh English', destroy() {} });
  await input('source', '会话甲'); await nodes.translate.trigger('click');
  nonempty = true; await nodes.fill.trigger('click');
  assert.equal(nodes.replaceBox.hidden, false);
  assert.equal(requests.filter(r => r.type === 'COMMIT').length, 0);
  await nodes.keep.trigger('click'); assert.equal(nodes.replaceBox.hidden, true);
  await nodes.fill.trigger('click'); await input('output', 'Revised English');
  assert.equal(nodes.replaceBox.hidden, true, 'editing result cancels pending confirmation');
  await nodes.fill.trigger('click'); await nodes.replace.trigger('click');
  const committed = requests.filter(r => r.type === 'COMMIT');
  assert.equal(committed.length, 1); assert.equal(committed[0].text, 'Revised English'); assert.equal(committed[0].replace, true);
  assert.ok(!Object.hasOwn(committed[0], 'source'));
  await input('output', 'English `// 中文注释` https://example.test/路径');
  assert.equal(nodes.fill.disabled, true); assert.match(nodes.boundaryStatus.textContent, /第 1 行/);
  const preparations = requests.filter(r => r.type === 'PREPARE').length;
  await nodes.fill.handlers.click();
  assert.equal(requests.filter(r => r.type === 'PREPARE').length, preparations, 'boundary blocks before any webpage message');
  await input('output', 'Revised English');

  target = { ...target, href: 'https://claude.ai/chat/b', revision: 1 }; poll(); await tick();
  assert.equal(nodes.source.value, ''); assert.equal(nodes.output.value, '');
  await input('source', '会话乙');
  target = { ...target, href: 'https://claude.ai/chat/a', revision: 2 }; poll(); await tick();
  assert.equal(nodes.source.value, '会话甲'); assert.equal(nodes.output.value, 'Revised English');
  target = { ...target, tabId: 2, documentId: 'doc2' }; poll(); await tick();
  assert.equal(nodes.source.value, '');
  chrome.tabs.onRemoved.listeners[0](1); await tick();
  assert.equal(memory['draft:1:https://claude.ai/chat/a'], undefined);
  assert.equal(memory['draft:1:https://claude.ai/chat/b'], undefined);
  assert.ok(requests.filter(r => ['PREPARE', 'COMMIT', 'CANCEL_FILL'].includes(r.type)).every(r => !JSON.stringify(r).includes('会话甲')));
  let replyCreates = 0;
  globalThis.Translator.create = async options => {
    assert.equal(options.sourceLanguage, 'en'); assert.equal(options.targetLanguage, 'zh'); replyCreates++;
    return { translate: async body => `阅读译文:${body}`, destroy() {} };
  };
  reply = { id: 'one', text: 'First answer.', stableText: 'First answer.', streaming: false };
  await nodes.readStart.trigger('click'); time += 2000; await poll(); await tick();
  assert.equal(nodes.replyText.textContent, '阅读译文:First answer.');
  await nodes.readingTab.trigger('click'); await nodes.originalTab.trigger('click');
  assert.equal(nodes.replyOriginalBox.hidden, false); assert.equal(nodes.originalReadMode.getAttribute('aria-pressed'), 'true');
  await nodes.originalTextMode.trigger('click'); assert.equal(nodes.replyOriginalText.textContent, 'First answer.');
  assert.equal(nodes.replyOriginalText.hidden, false);
  await nodes.askTab.trigger('click'); assert.equal(nodes.replyText.textContent, '阅读译文:First answer.');
  reply = { id: 'two', text: 'Second answer.', stableText: 'Second answer.', streaming: false };
  await poll(); time += 2000; await poll(); await tick();
  assert.equal(nodes.replyText.textContent, '阅读译文:Second answer.'); assert.equal(replyCreates, 1);
  assert.equal(nodes.readerIndicator.textContent, '自动阅读中');
  await nodes.readingTab.trigger('click'); assert.equal(nodes.replyOriginalText.textContent, 'Second answer.');
  assert.ok(!JSON.stringify(memory).includes('阅读译文')); assert.ok(!JSON.stringify(requests).includes('阅读译文'));
  assert.ok(requests.filter(r => r.type === 'READ_REPLY').every(r => Object.keys(r).sort().join() === 'target,type'));
  document.hidden = true; document.handlers.visibilitychange();
  assert.equal(nodes.replyText.textContent, ''); assert.equal(nodes.replyOriginal.textContent, '');
  const readCount = requests.filter(r => r.type === 'READ_REPLY').length;
  await poll(); assert.equal(requests.filter(r => r.type === 'READ_REPLY').length, readCount);
});
