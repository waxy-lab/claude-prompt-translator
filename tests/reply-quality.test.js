import test from 'node:test';
import assert from 'node:assert/strict';
import { translateReplyText } from '../lib/reply-text.js';
import { replyBlocks } from '../lib/reply-format.js';

test('整段上下文保留，代码/链接不传入模型且精确还原，碰撞前缀另选', async () => {
  const text = 'Calling `factorial(3)` unfolds like this. See <https://example.test/a_(b)?q=1>. CPT_KEEP_ is literal text.';
  let payload;
  const result = await translateReplyText(text, async body => { payload = body; return '译文：' + body; });
  assert.ok(payload.includes('Calling') && payload.includes('unfolds like this'), 'one call includes both sides of inline code');
  assert.ok(!payload.includes('factorial(3)')); assert.ok(!payload.includes('example.test'));
  assert.ok(payload.includes('cpt_keep_x00000'));
  assert.equal(result.text, '译文：' + text); assert.ok(!result.text.includes('cpt_keep_x00000'));
});

test('损坏、丢失、重复、重排标记均拒绝并退回分段，不泄漏占位符或篡改代码', async () => {
  for (const corrupt of [() => '没有标记', s => s.replace('cpt_keep_00000', 'CPT_KEEP_00000'), s => s + ' cpt_keep_00000', s => s.replace('cpt_keep_00000', 'TMP').replace('cpt_keep_00001', 'cpt_keep_00000').replace('TMP', 'cpt_keep_00001')]) {
    let first = true;
    const result = await translateReplyText('Calling `foo()` and `bar()` is safe.', async body => {
      if (first) { first = false; return corrupt(body); }
      return '中文';
    });
    assert.ok(result.text.includes('`foo()`') && result.text.includes('`bar()`'));
    assert.ok(!/cpt_keep_|TMP/.test(result.text)); assert.equal(result.warnings.length, 1);
  }
});

test('正文中的 Python 作为编程语言名称原样保留，不译为蟒蛇', async () => {
  let payload;
  const result = await translateReplyText('This Python function returns a value.', async body => { payload = body; return '中文：' + body; });
  assert.ok(!payload.includes('Python')); assert.ok(result.text.includes('Python')); assert.ok(!result.text.includes('蟒蛇'));
});

test('代码块完全跳过模型；解析器只移除固定格式分隔符，保留缩进和内部空行', async () => {
  const code = '\tdef factorial(n):\n\n\n    return n\n';
  const text = '### Example\n\n````Python\n' + code + '\n````';
  const result = await translateReplyText(text, async body => { assert.ok(!body.includes('factorial')); return '示例'; });
  const parsed = replyBlocks(result.text);
  assert.equal(parsed[0].kind, 'heading'); assert.equal(parsed[0].text, '示例');
  assert.equal(parsed[1].language, 'Python'); assert.equal(parsed[1].text, code);
  assert.ok(result.text.includes(code));
});

test('段落/列表紧凑输出，不跨代码全局折叠空白；未闭合围栏失败', async () => {
  const output = await translateReplyText('First sentence.\n\n\n\n- Next sentence.\n\n\nLast sentence.', async body => body);
  assert.equal(output.text, 'First sentence.\n\n- Next sentence.\n\nLast sentence.');
  assert.throws(() => replyBlocks('```Python\ncode'), /未闭合/);
});
