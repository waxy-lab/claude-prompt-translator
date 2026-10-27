import test from 'node:test';
import assert from 'node:assert/strict';
import { splitProtected, translateProtected, codePoints, validateSource } from '../lib/protected-text.js';
import { TaskGate, abortable } from '../lib/task-gate.js';
import { translateDraft, availability } from '../lib/translator.js';
import { DraftStore } from '../lib/draft-store.js';
import { isClaudeUrl, sameTarget, draftKey } from '../lib/target.js';

test('保护代码、URL、链接目标及换行，译文不依赖占位符', async () => {
  const source = '# 请解释\r\n```js\r\nconst 中文 = `x`;\r\n```\r\n以及 `中文()` 和 [文档](https://example.com/路径_(a)?q=中 "标题")\nhttps://example.com/保留?q=中文\n~~~python\nprint("中文")\n~~~\n末尾';
  const calls = [];
  const result = await translateProtected(source, async s => { calls.push(s); return 'EN'; });
  assert.deepEqual(calls, ['请解释', '以及', '和 [文档', '末尾']);
  const protectedIn = splitProtected(source).spans.filter(s => s.kind === 'protected').map(s => s.text);
  for (const value of protectedIn) assert.ok(result.text.includes(value), value);
  assert.equal((result.text.match(/\r\n|\n|\r/g) || []).length, (source.match(/\r\n|\n|\r/g) || []).length);
});

test('围栏长度、未闭合围栏与多反引号边界', async () => {
  const source = '````js\n```\n中文\n````\n说明 ``a ` 中`` 后文';
  const result = await translateProtected(source, async () => 'EN');
  assert.equal(result.text, '````js\n```\n中文\n````\nEN ``a ` 中`` EN');
  const unfinished = await translateProtected('说明\n~~~js\n中文', async () => 'EN');
  assert.equal(unfinished.text, 'EN\n~~~js\n中文');
  assert.equal(unfinished.warnings.length, 1);
});

test('不可靠结构明确失败，不静默误译代码', () => {
  for (const s of ['文字 `未闭合', '[文字](https://a.test/unclosed', '[文字](url\nnext)', '    const 中文 = 1;']) {
    assert.throws(() => splitProtected(s));
  }
});

test('英文、纯代码、引用定义与空格不调用翻译引擎', async () => {
  const source = '  Explain this code.\r\n```js\nconst 中文=1;\n```\n[ref]: https://x.test/中文 "中文"';
  assert.equal((await translateProtected(source, () => { throw Error('must not call'); })).text, source);
});

test('空白与 Unicode 12,000 边界，超长不截断', () => {
  assert.throws(() => validateSource(' \n\t'));
  assert.equal(codePoints('中😀'), 2);
  assert.doesNotThrow(() => validateSource('😀'.repeat(12000)));
  assert.throws(() => validateSource('😀'.repeat(12001)));
});

test('中英混排只传正文，前后空格、Markdown 前缀及中文标点外 URL 保留', async () => {
  const calls = [];
  const output = await translateProtected('-  请 explain `foo()`\n见 https://x.test/a。请继续', async s => { calls.push(s); return 'English'; });
  assert.deepEqual(calls, ['请 explain', '见', '。请继续']);
  assert.equal(output.text, '-  English `foo()`\nEnglish https://x.test/aEnglish');
});

test('某片段失败不能返回半截译文或凭空换行', async () => {
  let calls = 0;
  await assert.rejects(translateProtected('中文 `code` 中文', async () => { if (++calls === 2) throw Error('failure'); return 'English'; }));
  await assert.rejects(translateProtected('中文', async () => 'two\nlines'), /单行结构/);
  await assert.rejects(translateProtected('中文', async () => ''), /完整结果/);
});

test('任务取消、重新开始和迟到结果均受版本门控', async () => {
  const gate = new TaskGate();
  const first = gate.begin();
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const waiting = abortable(delayed, first.signal);
  const second = gate.begin();
  assert.equal(first.current(), false); assert.equal(second.current(), true);
  await assert.rejects(waiting, { name: 'AbortError' });
  release('late');
  gate.cancel(); assert.equal(second.current(), false);
});

test('API 状态缺失、支持与初始化异常', async () => {
  assert.equal(await availability('zh', {}), 'missing');
  assert.equal(await availability('zh-Hant', { create() {}, availability: async options => { assert.equal(options.sourceLanguage, 'zh-Hant'); return 'downloadable'; } }), 'downloadable');
  const signal = new AbortController().signal;
  await assert.rejects(translateDraft('中文', 'zh', { signal, API: {} }), /没有可用/);
  await assert.rejects(translateDraft('中文', 'zh', { signal, API: { create() { throw new DOMException('no', 'NotSupportedError'); } } }), /暂不支持/);
});

test('create 在调用时立即执行、进度范围、完整结果及 destroy', async () => {
  let created = false, destroyed = 0; const progress = [];
  const API = { create(options) {
    created = true;
    options.monitor({ addEventListener: (_name, fn) => { fn({ loaded: .5 }); fn({ loaded: 1.2 }); } });
    return Promise.resolve({ translate: async s => `EN(${s})`, destroy: () => destroyed++ });
  } };
  const promise = translateDraft('中文 `原样`', 'zh', { signal: new AbortController().signal, API, onProgress: n => progress.push(n) });
  assert.equal(created, true);
  assert.equal((await promise).text, 'EN(中文) `原样`');
  assert.deepEqual(progress, [50, 100]); assert.equal(destroyed, 1);
});

test('取消初始化后迟到实例被销毁，取消翻译也销毁实例', async () => {
  let resolveCreate, destroyed = 0;
  const controller = new AbortController();
  const pending = translateDraft('中文', 'zh', { signal: controller.signal, API: { create: () => new Promise(resolve => { resolveCreate = resolve; }) } });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  resolveCreate({ destroy() { destroyed++; } }); await new Promise(r => setImmediate(r));
  assert.equal(destroyed, 1);
  const next = new AbortController();
  let entered;
  const started = new Promise(r => { entered = r; });
  const translating = translateDraft('中文', 'zh', { signal: next.signal, API: { create: async () => ({ translate() { entered(); return new Promise(() => {}); }, destroy() { destroyed++; } }) } });
  await started; next.abort();
  await assert.rejects(translating, { name: 'AbortError' }); assert.ok(destroyed >= 2);
});

test('纯英文和代码在 API 不可用时也能按原样预览', async () => {
  const text = 'English\n```\n中文\n```';
  assert.equal((await translateDraft(text, 'zh', { signal: new AbortController().signal, API: {} })).text, text);
});

test('草稿写入/清空顺序，恢复与传入对象快照', async () => {
  const memory = {};
  const store = new DraftStore({
    async set(value) { await new Promise(r => setTimeout(r, 2)); Object.assign(memory, value); },
    async get(key) { return key === null ? structuredClone(memory) : { [key]: structuredClone(memory[key]) }; },
    async remove(key) { for (const item of Array.isArray(key) ? key : [key]) delete memory[item]; }
  });
  const draft = { source: '第一版' };
  const saved = store.save('one', draft); draft.source = '改动';
  await saved; assert.equal((await store.read('one')).source, '第一版');
  store.save('one', { source: 'old' }); await store.clear('one'); assert.equal(await store.read('one'), null);
  await store.save('two', { source: '另一页' }); assert.equal((await store.read('two')).source, '另一页');
  store.save('draft:1:https://claude.ai/chat/a', { source: '待清理' });
  store.save('draft:2:https://claude.ai/chat/a', { source: '另一个标签' });
  await store.clearTab(1);
  assert.equal(await store.read('draft:1:https://claude.ai/chat/a'), null);
  assert.equal((await store.read('draft:2:https://claude.ai/chat/a')).source, '另一个标签');
});

test('严格 URL、安全目标身份和会话隔离', () => {
  assert.equal(isClaudeUrl('https://claude.ai/new'), true);
  for (const u of ['http://claude.ai/', 'https://claude.ai.evil.test/', 'https://sub.claude.ai/', 'https://claude.ai:444/', 'https://x@claude.ai/', 'javascript:alert(1)', undefined]) assert.equal(isClaudeUrl(u), false, String(u));
  const target = { tabId: 1, windowId: 1, href: 'https://claude.ai/chat/a', documentId: 'doc1', nonce: 'nonce1', revision: 0 };
  assert.ok(sameTarget(target, { ...target }));
  for (const field of Object.keys(target)) assert.equal(sameTarget(target, { ...target, [field]: 'changed' }), false);
  assert.notEqual(draftKey(target), draftKey({ ...target, tabId: 2 }));
  assert.notEqual(draftKey(target), draftKey({ ...target, href: 'https://claude.ai/chat/b' }));
});
