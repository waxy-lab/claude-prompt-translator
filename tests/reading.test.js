import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoReader } from '../lib/auto-reader.js';
import { ReplyTranslator } from '../lib/reply-translator.js';
import { englishPrompt, containsChinese, chineseLocations } from '../lib/text-boundary.js';
import { splitProtected } from '../lib/protected-text.js';

const signal = () => new AbortController().signal;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(r => setImmediate(r));
const target = { tabId: 1, windowId: 1, href: 'https://claude.ai/chat/one', nonce: 'n', documentId: 'd', revision: 0 };
const reply = (id, text, options = {}) => ({ ok: true, reply: { id, text, stableText: text, streaming: false, ...options } });

test('英文提问严格原样返回，不附加语言、国籍或身份指令', () => {
  for (const text of ['Explain recursion.', '  Show `foo()` at https://a.test/x\nKeep whitespace.  ', 'Use café and 😀.']) assert.equal(englishPrompt(text), text);
  assert.equal(containsChinese('English, [] () !? café 😀'), false);
});

test('汉字、全角、代码注释和链接中字符均拦截，并定位 Unicode 行列', () => {
  for (const text of ['中文', 'Ｈｅｌｌｏ', 'English。', '￥10', '\uFE10', '```js\n// 注释\n```', '`/路径/file.js`', 'https://a.test/中文', 'https://a.test/?q=“中文”']) {
    assert.equal(containsChinese(text), true, text); assert.throws(() => englishPrompt(text));
  }
  assert.deepEqual(chineseLocations('😀A\n中。'), { count: 2, locations: [{ character: '中', line: 2, column: 1 }, { character: '。', line: 2, column: 2 }] });
});

test('回复识别标识保护不会将普通句末标点误判为技术标识', () => {
  const text = 'Use readFile with API, MAX_SIZE, C++, foo.bar(), --dry-run and /tmp/a.py. Recursion stops.';
  const spans = splitProtected(text, { protectTechnical: true }).spans;
  assert.equal(spans.map(s => s.text).join(''), text);
  for (const token of ['readFile', 'API', 'MAX_SIZE', 'C++', 'foo.bar()', '--dry-run', '/tmp/a.py.']) assert.ok(spans.some(s => s.kind === 'protected' && s.text.includes(token)), token);
  assert.ok(spans.some(s => s.kind === 'text' && s.text.includes('Recursion stops.')));
});

test('回复引擎一次初始化、多条自动翻译复用，代码/URL/技术标识不传入模型', async () => {
  let creates = 0, destroys = 0; const calls = [];
  const engine = new ReplyTranslator();
  const enabling = engine.enable({ signal: signal(), API: { create(options) {
    creates++; assert.equal(options.sourceLanguage, 'en'); assert.equal(options.targetLanguage, 'zh');
    return Promise.resolve({ translate: async body => { calls.push(body); return '中文'; }, destroy() { destroys++; } });
  } } });
  assert.equal(creates, 1, 'create runs synchronously before awaiting user gesture'); await enabling;
  const text = 'Explain readFile and `x()` at https://example.test/path\n```js\n// English comment\nlet x = 1;\n```\nNext sentence.';
  const first = await engine.translate(text, signal());
  for (const token of ['readFile', '`x()`', 'https://example.test/path', 'let x = 1;', '// English comment']) assert.ok(first.text.includes(token), token);
  assert.ok(calls.every(s => !/readFile|x\(\)|https:|let x|comment/.test(s)));
  const count = calls.length; await engine.translate(text, signal()); assert.equal(calls.length, count);
  await engine.translate('Another answer.', signal()); assert.equal(creates, 1);
  engine.destroy(); assert.equal(destroys, 1);
});

test('回复缓存有容量限制、导航销毁后不复用，60,000 长文拒绝且不截断', async () => {
  let calls = 0;
  const API = { create: async () => ({ translate: async body => { calls++; return `译${body}`; }, destroy() {} }) };
  const engine = new ReplyTranslator({ cacheLimit: 12 });
  await engine.enable({ signal: signal(), API });
  for (const body of ['one', 'two', 'one']) await engine.translate(body, signal());
  assert.equal(calls, 3, 'oldest cache entry evicted');
  await assert.rejects(engine.translate('a'.repeat(60001), signal()), /60,000/);
  await engine.enable({ signal: signal(), API }); await engine.translate('one', signal()); assert.equal(calls, 4);
  engine.destroy();
});

test('回复引擎过期初始化不能覆盖新实例，迟到实例被销毁', async () => {
  const old = deferred(); let oldDestroyed = 0;
  const engine = new ReplyTranslator();
  const first = engine.enable({ signal: signal(), API: { create: () => old.promise } });
  const firstRejected = assert.rejects(first, { name: 'AbortError' });
  await engine.enable({ signal: signal(), API: { create: async () => ({ translate: async () => '新的译文', destroy() {} }) } });
  await firstRejected;
  old.resolve({ translate: async () => '旧译文', destroy() { oldDestroyed++; } }); await tick();
  assert.equal(oldDestroyed, 1); assert.equal((await engine.translate('Current answer.', signal())).text, '新的译文');
  engine.destroy();
});

test('回复语言包不可用、设置超时、翻译超时和失败均有确定结果', async () => {
  const engine = new ReplyTranslator({ setupTimeout: 8, translateTimeout: 8 });
  await assert.rejects(engine.enable({ API: {} }), /没有可用/);
  await assert.rejects(engine.enable({ API: { create: async () => { throw new DOMException('unsupported', 'NotSupportedError'); } } }), /引擎未就绪/);
  await assert.rejects(engine.enable({ API: { create: () => new Promise(() => {}) } }), /准备超时/);
  await engine.enable({ API: { create: async () => ({ translate: () => new Promise(() => {}), destroy() {} }) } });
  await assert.rejects(engine.translate('Pending.', signal()), /翻译超时/); engine.destroy();
  await engine.enable({ API: { create: async () => ({ translate: async () => '', destroy() {} }) } });
  await assert.rejects(engine.translate('Empty.', signal()), /未发布本次部分结果/); engine.destroy();
});

test('主动暂停时销毁模型会中断悬挂翻译', async () => {
  const started = deferred();
  const engine = new ReplyTranslator();
  await engine.enable({ API: { create: async () => ({ translate() { started.resolve(); return new Promise(() => {}); }, destroy() {} }) } });
  const translating = engine.translate('Pending.', signal()); await started.promise; engine.destroy();
  await assert.rejects(translating, { name: 'AbortError' });
});

function readerFixture(options = {}) {
  let value = reply('one', 'First answer.'), now = 0, creates = 0, reads = 0;
  const calls = [], changes = [];
  const translator = options.translator || {
    enable() { creates++; return Promise.resolve(); },
    async translate(text) { calls.push(text); return { text: `中:${text}`, warnings: [] }; }, destroy() {}
  };
  const reader = new AutoReader({ translator, read: async () => { reads++; return value; }, onChange: state => changes.push(state), clock: () => now, ...options });
  return { reader, calls, changes, get creates() { return creates; }, get reads() { return reads; }, set(valueToUse) { value = valueToUse; }, advance(ms = 2000) { now += ms; } };
}

test('自动阅读开启一次，连续两条新回复无需再次点击，短期抖动不翻译', async () => {
  const f = readerFixture(); await f.reader.enable(target);
  assert.equal(f.calls.length, 0); f.advance(); await f.reader.poll(); await f.reader.translationPromise;
  assert.equal(f.reader.state.translation, '中:First answer.');
  f.set(reply('two', 'Second answer.')); await f.reader.poll(); assert.equal(f.reader.state.translation, '');
  f.advance(); await f.reader.poll(); await f.reader.translationPromise;
  assert.equal(f.reader.state.translation, '中:Second answer.'); assert.equal(f.creates, 1); assert.equal(f.calls.length, 2);
  await f.reader.poll(); assert.equal(f.calls.length, 2); f.reader.stop();
});

test('流式只译稳定前缀，未稳定尾部持续变化不反复取消前缀翻译', async () => {
  const pending = deferred(); const started = deferred(); let count = 0;
  const f = readerFixture({ translator: { enable: async () => {}, destroy() {}, translate: () => { count++; started.resolve(); return pending.promise; } } });
  f.set(reply('one', 'Stable paragraph.\nChanging a', { streaming: true, stableText: 'Stable paragraph.' }));
  await f.reader.enable(target); f.advance(); await f.reader.poll(); await started.promise;
  f.set(reply('one', 'Stable paragraph.\nChanging abcdef', { streaming: true, stableText: 'Stable paragraph.' })); await f.reader.poll();
  pending.resolve({ text: '稳定段落。', warnings: [] }); await f.reader.translationPromise;
  assert.equal(count, 1); assert.equal(f.reader.state.translation, '稳定段落。'); assert.match(f.reader.state.message, /仍在生成/);
  f.reader.stop();
});

test('新回复出现时迟到旧译文不发布，暂停后不继续读取', async () => {
  const pending = deferred(); let calls = 0;
  const f = readerFixture({ translator: { enable: async () => {}, destroy() {}, translate: async () => ++calls === 1 ? pending.promise : { text: '新译文', warnings: [] } } });
  await f.reader.enable(target); f.advance(); await f.reader.poll(); const old = f.reader.translationPromise;
  f.set(reply('two', 'New answer.')); await f.reader.poll(); f.advance(); await f.reader.poll(); await f.reader.translationPromise;
  pending.resolve({ text: '迟到旧结果', warnings: [] }); await old;
  assert.equal(f.reader.state.translation, '新译文'); f.reader.stop(); const reads = f.reads;
  await f.reader.poll(); assert.equal(f.reads, reads); assert.equal(f.reader.state.original, ''); assert.equal(f.reader.state.translation, '');
});

test('目标改变或隐藏时由 stop 立即清空，旧页面读取不能串入新会话', async () => {
  const oldRead = deferred(); let reads = 0;
  const f = readerFixture({ read: async expected => { if (++reads === 1) return oldRead.promise; return reply(expected.href, 'New scope.'); } });
  const first = f.reader.enable(target); await tick(); f.reader.stop('hidden');
  await f.reader.enable({ ...target, href: 'https://claude.ai/chat/two' });
  oldRead.resolve(reply('old', 'Old secret.')); await first;
  assert.equal(f.reader.state.original, 'New scope.'); assert.ok(!f.changes.slice(f.changes.findIndex(s => s.message === 'hidden')).some(s => s.original.includes('Old secret')));
  f.reader.stop();
});

test('读取定位失败、页面超时、超长、翻译错误后暂停且必须显式重试', async () => {
  for (const value of [{ ok: false, message: 'permission lost' }, reply('long', 'x'.repeat(60001))]) {
    const f = readerFixture(); f.set(value); await f.reader.enable(target);
    assert.equal(f.reader.state.enabled, false); assert.equal(f.reader.state.phase, 'error');
  }
  const f = readerFixture({ read: () => new Promise(() => {}), readTimeout: 8 });
  await f.reader.enable(target); assert.match(f.reader.state.message, /读取页面超时/);
  const failed = readerFixture({ translator: { enable: async () => {}, destroy() {}, translate: async () => { throw Error('model failure'); } } });
  await failed.reader.enable(target); failed.advance(); await failed.reader.poll(); await failed.reader.translationPromise;
  assert.equal(failed.reader.state.enabled, false); assert.equal(failed.reader.state.translation, ''); assert.equal(failed.reader.state.message, 'model failure');
});

test('无已识别助手回复时只等待，不翻译整页或用户输入', async () => {
  const f = readerFixture(); f.set({ ok: true, reply: null, message: 'No marked assistant' });
  await f.reader.enable(target); f.advance(); await f.reader.poll();
  assert.equal(f.calls.length, 0); assert.equal(f.reader.state.enabled, true); assert.equal(f.reader.state.original, ''); f.reader.stop();
});
