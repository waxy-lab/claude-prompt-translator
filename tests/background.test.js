import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('后台协调：限制消息来源、重新核对目标、按 documentId 填入及关闭页清理', async t => {
  const hook = () => ({ addListener(fn) { this.fn = fn; } });
  const own = 'chrome-extension://test/sidepanel.html';
  const identity = { href: 'https://claude.ai/chat/a', nonce: 'nonce', revision: 0 };
  let tab = { id: 1, windowId: 2, url: identity.href };
  let doc = 'doc1', calls = [], removed;
  globalThis.chrome = {
    action: { onClicked: hook() },
    sidePanel: { open: async args => calls.push({ open: args }) },
    runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: hook(), onInstalled: hook() },
    storage: { session: { async get() { return { 'draft:1:https://claude.ai/chat/a': {}, 'draft:2:https://claude.ai/chat/a': {} }; }, async remove(keys) { removed = keys; }, async setAccessLevel() {} } },
    tabs: { query: async () => [tab], onRemoved: hook() },
    scripting: { async executeScript(options) {
      calls.push(options);
      if (options.func.name === 'captureIdentity') return [{ documentId: doc, result: { ...identity } }];
      return [{ documentId: doc, result: { ok: true, inserted: true } }];
    } }
  };
  t.after(() => { delete globalThis.chrome; });
  await import('../background.js');
  const sender = { id: 'test', url: own };
  const send = request => new Promise(resolve => { assert.equal(chrome.runtime.onMessage.fn(request, sender, resolve), true); });
  let responded = false;
  assert.equal(chrome.runtime.onMessage.fn({ type: 'TARGET' }, { id: 'test', url: 'https://claude.ai/' }, () => { responded = true; }), false);
  assert.equal(responded, false); assert.equal(calls.length, 0);
  const result = await send({ type: 'TARGET', windowId: 2 });
  assert.equal(result.ok, true); const target = result.target;
  calls = []; doc = 'other-document';
  assert.equal((await send({ type: 'COMMIT', target, text: 'English', token: 'token' })).ok, false);
  assert.equal(calls.filter(c => c.func?.name === 'claudeAdapter').length, 0);
  doc = 'doc1'; calls = [];
  assert.equal((await send({ type: 'COMMIT', target, text: 'English', token: 'token', replace: true })).ok, true);
  const inserted = calls.find(c => c.func?.name === 'claudeAdapter');
  assert.deepEqual(inserted.target, { tabId: 1, documentIds: ['doc1'] });
  assert.equal(inserted.world, 'ISOLATED'); assert.equal(inserted.args[0].text, 'English');
  assert.equal(inserted.args[0].replace, true);
  calls = [];
  assert.equal((await send({ type: 'COMMIT', target, text: 'English `中文`', token: 'token' })).ok, false);
  assert.equal(calls.length, 0, 'Chinese never reaches an injected function');
  assert.equal((await send({ type: 'READ_REPLY', target, source: 'must not forward', translation: '不得传入网页' })).ok, true);
  const read = calls.find(c => c.func?.name === 'readLatestReply');
  assert.equal(read.world, 'ISOLATED'); assert.deepEqual(read.target.documentIds, ['doc1']);
  assert.deepEqual(read.args, [target]);
  tab = { ...tab, url: 'https://claude.ai.evil.test/' }; calls = [];
  assert.equal((await send({ type: 'TARGET', windowId: 2 })).ok, false); assert.equal(calls.length, 0);
  await chrome.tabs.onRemoved.fn(1); assert.deepEqual(removed, ['draft:1:https://claude.ai/chat/a']);
  chrome.action.onClicked.fn({ windowId: 2 }); assert.deepEqual(calls[0], { open: { windowId: 2 } });
});

test('交付清单只包含最小权限，没有常驻网页注入及网络上传入口', async () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await fs.readFile(new URL('manifest.json', root), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.slice().sort(), ['activeTab', 'scripting', 'sidePanel', 'storage']);
  for (const key of ['host_permissions', 'content_scripts', 'externally_connectable', 'web_accessible_resources']) assert.equal(manifest[key], undefined);
  assert.ok(manifest.content_security_policy.extension_pages.includes("connect-src 'none'"));
  const files = ['background.js', 'sidepanel.js', 'lib/translator.js', 'lib/draft-store.js', 'lib/protected-text.js', 'lib/task-gate.js', 'lib/target.js', 'content/claude-adapter.js', 'content/reply-reader.js', 'lib/auto-reader.js', 'lib/reply-translator.js', 'lib/text-boundary.js'];
  for (const file of files) {
    const source = await fs.readFile(new URL(file, root), 'utf8');
    assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/.test(source), file);
    assert.ok(!source.includes('storage.sync'), file);
  }
});
