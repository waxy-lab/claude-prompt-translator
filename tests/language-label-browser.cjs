// Public regression fixtures only. Actual isolated Chrome DOM; translation below is mocked.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const root = path.resolve(__dirname, '..');
  const base = 'cd8095932ee1141eb6f08ae96a9b510ff6240a3e';
  const baseline = execFileSync('git', ['show', base + ':content/reply-reader.js'], { cwd: root, encoding: 'utf8' });
  const { readLatestReply } = await import('../content/reply-reader.js');
  const { captureIdentity } = await import('../lib/target.js');
  const { replyBlocks, renderReply } = await import('../lib/reply-format.js');
  const { translateReplyText } = await import('../lib/reply-text.js');
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const wrap = (value, depth) => '<div>'.repeat(depth) + value + '</div>'.repeat(depth);
  const countdown = 'def countdown(n):\n    if n == 0:\n        print("Liftoff!")\n        return\n\n    print(n)\n    countdown(n - 1)\n';
  const total = 'def total(nums):\n    if not nums:\n        return 0\n    return nums[0] + total(nums[1:])\n';
  const component = (label, code, depth = 2, metadata = 'class="language-python"') => '<section><div><span>' + label + '</span><div><button>Copy</button></div></div>' + wrap('<pre><code ' + metadata + '>' + escape(code) + '</code></pre>', depth) + '</section>';
  const sample = '<h2>Countdown</h2>' + component('python', countdown) + '<p>Keep this reminder.</p><h2>Sum</h2>' + component('python', total, 3);
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const results = [], errors = [];
  try {
    const context = await browser.newContext(); let markup = '';
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><article data-testid="assistant-message"><div class="standard-markdown">' + markup + '</div></article>' }));
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    const run = (fn, arg) => page.evaluate(({ source, arg }) => (new Function('return (' + source + ')'))()(arg), { source: fn.toString(), arg });
    async function read(html, old = false) {
      markup = html; await page.goto('https://claude.ai/chat/public-language-fixture');
      const expected = await run(captureIdentity); const before = await page.locator('body').innerHTML();
      const value = old ? await page.evaluate(({ source, arg }) => (new Function(source.replace('export function', 'function') + ';return readLatestReply;'))()(arg), { source: baseline, arg: expected }) : await run(readLatestReply, expected);
      assert.equal(value.ok, true); assert.equal(await page.locator('body').innerHTML(), before); return value.reply.text;
    }
    const before = await read(sample, true);
    const beforeBlocks = replyBlocks(before);
    const reproduction = { base, standalonePythonLabels: beforeBlocks.filter(b => b.kind !== 'code' && /^python$/i.test(b.text)).length, codeLanguages: beforeBlocks.filter(b => b.kind === 'code').map(b => b.language) };
    assert.equal(reproduction.standalonePythonLabels, 2);
    if (!process.env.LANGUAGE_BASELINE_ONLY) {
      const text = await read(sample), blocks = replyBlocks(text);
      assert.equal(blocks.filter(b => b.kind !== 'code' && /^python$/i.test(b.text)).length, 0);
      assert.deepEqual(blocks.filter(b => b.kind === 'code').map(b => [b.language, b.text]), [['python', countdown], ['python', total]]);
      assert.ok(text.includes('Keep this reminder.'));
      const calls = [];
      const translated = await translateReplyText(text, async body => { calls.push(body); return body.replace(/\bpython\b/gi, '蟒蛇'); });
      assert.ok(calls.every(body => !/python|def countdown|def total/i.test(body)));
      assert.ok(!translated.text.includes('蟒蛇'));
      const rendered = await page.evaluate(({ parser, renderer, text }) => {
        const replyBlocks = eval('(' + parser + ')'), renderReply = eval('(' + renderer + ')');
        const node = document.createElement('div'); renderReply(node, text);
        return { code: [...node.querySelectorAll('.reply-code code')].map(n => n.textContent), languages: [...node.querySelectorAll('.code-language')].map(n => n.textContent) };
      }, { parser: replyBlocks.toString(), renderer: renderReply.toString(), text: translated.text });
      assert.deepEqual(rendered, { code: [countdown, total], languages: ['python', 'python'] });
      results.push({ name: 'two nested lowercase python components: no translated duplicate, exact countdown/total code, no language/code in model arguments', passed: true });
      for (const label of ['Python', 'python', 'PYTHON']) for (const depth of [0, 2, 4]) for (const metadata of ['', 'class="language-python"', 'data-language="python"']) {
        const text = await read(component(label, countdown, depth, metadata)); const blocks = replyBlocks(text);
        assert.equal(blocks.length, 1); assert.equal(blocks[0].kind, 'code'); assert.equal(blocks[0].text, countdown);
        assert.equal(blocks[0].language.toLowerCase(), 'python');
      }
      results.push({ name: '27 combinations: Python/python/PYTHON, zero/two/four code wrappers, language metadata present/absent', passed: true });
      const mixed = '<div><p>Important: preserve this warning.</p><button>More</button></div>' + component('python', countdown, 2) + '<div>Keep raw prose.<button>More</button></div>';
      const preserved = await read(mixed);
      assert.ok(preserved.includes('Important: preserve this warning.')); assert.ok(preserved.includes('Keep raw prose.'));
      const ambiguous = await read('<section><div><span>python</span><p>Meaningful mixed header.</p><button>Copy</button></div>' + wrap('<pre><code class="language-python">' + escape(total) + '</code></pre>', 2) + '</section>');
      assert.ok(ambiguous.includes('Meaningful mixed header.')); assert.ok(ambiguous.includes('python'));
      const retained = await translateReplyText(ambiguous, async body => body);
      assert.ok(retained.warnings.some(w => /孤立/.test(w))); assert.ok(retained.text.includes('python'));
      results.push({ name: 'mixed paragraphs/raw warnings never dropped; ambiguous prose header retained with English-name warning', passed: true });
      const animal = await read('<p>A python is a large snake.</p>' + component('PYTHON', total));
      const animalCalls = [];
      const animalResult = await translateReplyText(animal, async body => { animalCalls.push(body); return body.replace('python', '蟒蛇'); });
      assert.ok(animalCalls.some(body => body.includes('A python is a large snake.'))); assert.ok(animalResult.text.includes('蟒蛇'));
      results.push({ name: 'animal python prose beside code is retained and sent to the model normally', passed: true });
      const controls = '<section>' + wrap('<div><span>PYTHON</span>' + wrap('<button>Copy</button>', 2) + '</div>', 2) + wrap('<pre data-language="python"><code>' + escape(total) + '</code></pre>', 2) + '</section>';
      assert.equal(replyBlocks(await read(controls)).length, 1);
      const separate = await read('<div><span>python</span></div><div>' + component('JavaScript', total, 0, 'class="language-javascript"') + component('python', countdown) + '</div>');
      assert.ok(replyBlocks(separate).some(b => b.kind === 'paragraph' && b.text === 'python'), 'multi-code ancestors do not absorb unrelated labels');
      const deep = await read(component('python', total, 7));
      assert.ok(replyBlocks(deep).some(b => b.kind === 'paragraph' && b.text === 'python'), 'unsupported depth preserves rather than deletes');
      const conflict = replyBlocks(await read(component('python', total, 2, 'class="language-javascript"')));
      assert.ok(conflict.some(b => b.kind === 'paragraph' && b.text === 'python'), 'conflicting labels are retained');
      assert.equal(conflict.find(b => b.kind === 'code').language, 'javascript');
      const adjacent = replyBlocks(await read('<div>python<button>Copy</button></div><pre><code>' + escape(countdown) + '</code></pre><div>PYTHON<button>Copy</button></div><pre><code>' + escape(total) + '</code></pre>'));
      assert.deepEqual(adjacent.map(b => [b.kind, b.language]), [['code', 'python'], ['code', 'PYTHON']]);
      results.push({ name: 'nested language/copy controls and pre metadata; bounded multi-code/deep ancestors preserve ambiguous text', passed: true });
    }
    assert.deepEqual(errors, []);
    const report = { date: '2026-10-27', browser: browser.version(), scope: 'Public synthetic DOM, not user-page DOM. Real Chrome reader and renderer; model is mocked, model arguments asserted. No live Claude.', reproduction, results, runtimeErrors: errors };
    fs.writeFileSync(path.join(root, 'evidence', 'language-label-0.2.4.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
