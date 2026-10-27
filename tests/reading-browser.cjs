// Real Chrome renderer + local HTML fixtures. Translator and Chrome extension APIs mocked.
// Every request is intercepted; no live Claude service or daily browser profile is used.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const root = path.resolve(__dirname, '..');
  const { readLatestReply } = await import('../content/reply-reader.js');
  const { captureIdentity } = await import('../lib/target.js');
  const { claudeAdapter } = await import('../content/claude-adapter.js');
  const { replyBlocks, renderReply } = await import('../lib/reply-format.js');
  const { translateReplyText } = await import('../lib/reply-text.js');
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const results = [], runtimeErrors = [], requests = [];
  const files = new Set(['sidepanel.html', 'sidepanel.css', 'sidepanel.js', ...fs.readdirSync(path.join(root, 'lib')).filter(n => n.endsWith('.js')).map(n => 'lib/' + n)]);
  let markup = '';
  try {
    const context = await browser.newContext({ viewport: { width: 450, height: 1050 } });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'claude.ai') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><style>body{font:16px sans-serif} [contenteditable]{min-height:60px}</style>' + markup });
      const name = url.pathname.slice(1);
      if (url.hostname === 'panel.fixture.test' && files.has(name)) {
        return route.fulfill({ body: fs.readFileSync(path.join(root, name)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', headers: { 'Content-Security-Policy': "script-src 'self'; object-src 'none'; connect-src 'none'" } });
      }
      return route.fulfill({ status: 404, body: 'Not allowed in fixture' });
    });
    const page = await context.newPage();
    let expected;
    const run = (fn, arg) => page.evaluate(({ source, arg }) => (new Function(`return (${source})`))()(arg), { source: fn.toString(), arg });
    async function setup(html) { markup = html; await page.goto('https://claude.ai/chat/fixture'); expected = await run(captureIdentity); assert.ok(expected); }
    async function scenario(name, html, verify) {
      await setup(html); await verify(); results.push({ name, passed: true });
    }
    await scenario('only marked assistant body, excludes user/draft/thinking/artifact, preserves code and exact link target; no DOM writes',
      '<div data-message-author-role="user">USER_SECRET</div><textarea>DRAFT_SECRET</textarea><article data-message-author-role="assistant" data-message-id="one"><div data-testid="Thinking-block">THOUGHT_SECRET</div><p>Use <code>readFile()</code> and <a href="https://example.test/a_(b)?x=1&amp;y=2">Docs</a>.</p><pre><code>\tconst x = `value`;\n// 中文注释\n\n</code></pre><button>Copy</button></article><aside><div class="font-claude-response">ARTIFACT_SECRET</div></aside>', async () => {
        const before = await page.locator('body').innerHTML(); const result = await run(readLatestReply, expected);
        assert.equal(result.ok, true);
        for (const secret of ['USER_SECRET', 'DRAFT_SECRET', 'THOUGHT_SECRET', 'ARTIFACT_SECRET', 'Copy']) assert.ok(!result.reply.text.includes(secret), secret);
        assert.ok(result.reply.text.includes('`readFile()`')); assert.ok(result.reply.text.includes('https://example.test/a_(b)?x=1&y=2'));
        assert.ok(result.reply.text.includes('\tconst x = `value`;\n// 中文注释\n\n'));
        assert.equal(await page.locator('body').innerHTML(), before);
      });
    await scenario('latest assistant selected, nested markers deduplicated', '<article data-message-author-role="assistant"><p>Old answer.</p></article><article data-testid="assistant-message"><div class="font-claude-response"><p>Latest answer.</p></div></article><div data-message-author-role="user">Later user text</div>', async () => {
      const r = await run(readLatestReply, expected); assert.ok(r.reply.text.includes('Latest answer.')); assert.ok(!r.reply.text.includes('Old answer')); assert.equal(r.reply.text.match(/Latest answer/g).length, 1);
    });
    await scenario('streaming stable block excludes mutable trailing block', '<article data-testid="assistant-message" data-is-streaming="true"><p>Stable paragraph.</p><p>Mutable tail</p></article>', async () => {
      const r = await run(readLatestReply, expected); assert.equal(r.reply.streaming, true); assert.ok(r.reply.stableText.includes('Stable paragraph.')); assert.ok(!r.reply.stableText.includes('Mutable tail'));
    });
    await scenario('single wrapper while streaming safely waits rather than exposing partial as complete', '<article data-testid="assistant-message" data-is-streaming="true"><div><p>Paragraph.</p><p>Mutable tail</p></div></article>', async () => {
      assert.equal((await run(readLatestReply, expected)).reply.stableText, '');
    });
    await scenario('no marker never falls back to whole page or editor', '<main><p>Unmarked whole-page text</p><div contenteditable="true">User draft</div></main>', async () => {
      assert.equal((await run(readLatestReply, expected)).reply, null);
    });
    await scenario('overlong reply rejected without partial text', `<article data-testid="assistant-message"><p>${'a'.repeat(60001)}</p></article>`, async () => {
      const r = await run(readLatestReply, expected); assert.equal(r.ok, false); assert.equal(r.reply, undefined);
    });
    await scenario('identity mismatch rejected before reading', '<article data-testid="assistant-message">Secret answer</article>', async () => {
      const r = await run(readLatestReply, { ...expected, revision: expected.revision + 1 }); assert.equal(r.ok, false); assert.equal(r.reply, undefined);
    });
    await scenario('unsupported math fails explicitly, image-only answer does not trigger whole-page reading', '<article data-testid="assistant-message"><p>Some prose.</p><math>x</math></article>', async () => {
      assert.equal((await run(readLatestReply, expected)).ok, false);
      await page.locator('article').evaluate(el => { el.innerHTML = '<img alt="not read" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">'; });
      assert.equal((await run(readLatestReply, expected)).reply, null);
    });

    await scenario('feedback reproduction: narrow Markdown body, no reader summary/promo/time, compact nesting and code language',
      '<article data-message-author-role="assistant"><span class="sr-only">Claude responded: Recursion is when... dire...</span><div class="font-claude-response"><div class="standard-markdown"><div><div><p>Recursion solves a smaller problem.</p></div></div><div><h2>Example 1: Factorial</h2><div><div><span>Python</span><button>Copy</button></div><pre><code class="language-python">def factorial(n):\n\n\n    return n\n</code></pre></div><p>Calling <code>factorial(3)</code> unfolds like this.</p></div></div><div data-testid="code-promo"><p>Claude works directly with your codebase</p><button>Install</button></div><time>9 hours ago</time></div></article>', async () => {
        const before = await page.locator('body').innerHTML(); const result = await run(readLatestReply, expected);
        assert.equal(result.ok, true);
        for (const noise of ['Claude responded', 'dire...', 'codebase', '9 hours', 'Copy', 'Install']) assert.ok(!result.reply.text.includes(noise), noise);
        assert.equal(result.reply.text.match(/Recursion solves/g).length, 1);
        assert.ok(result.reply.text.includes('```python\ndef factorial(n):\n\n\n    return n\n\n```'));
        assert.ok(result.reply.text.includes('Calling `factorial(3)` unfolds'));
        const withoutCode = result.reply.text.replace(/```python[\s\S]*?```/g, 'CODE');
        assert.ok(!/\n{3}/.test(withoutCode), 'wrappers do not create repeated blank lines');
        assert.equal(await page.locator('body').innerHTML(), before);
      });
    await scenario('CSS-clipped accessibility preview excluded even without sr-only class', '<article data-testid="assistant-message"><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">A11Y_PREVIEW</span><p>Actual answer.</p><footer>9 hours ago</footer></article>', async () => {
      const result = await run(readLatestReply, expected); assert.ok(!result.reply.text.includes('A11Y_PREVIEW')); assert.equal(result.reply.text.trim(), 'Actual answer.');
    });

    await scenario('R1: newer font marker outranks older role; appending nested testid message changes latest ID once',
      '<article data-message-author-role="assistant"><p>Older marked answer.</p></article><div class="font-claude-response"><p>Newest font answer.</p></div><aside><div class="font-claude-response">Not an answer</div></aside>', async () => {
        const first = await run(readLatestReply, expected);
        assert.equal(first.reply.text, 'Newest font answer.'); assert.ok(first.reply.id.startsWith('2:'));
        await page.locator('body').evaluate(el => {
          const article = document.createElement('article'); article.dataset.testid = 'assistant-message';
          article.innerHTML = '<div class="font-claude-response"><p>Newest appended answer.</p></div>';
          el.append(article);
        });
        const next = await run(readLatestReply, expected);
        assert.equal(next.reply.text, 'Newest appended answer.'); assert.notEqual(next.reply.id, first.reply.id);
        assert.ok(next.reply.id.startsWith('3:'), 'nested marker contributes only one independent message');
      });
    await scenario('R1: newer role/testid markers outrank older font marker in reversed order',
      '<div class="font-claude-response"><p>Older font answer.</p></div><article data-message-author-role="assistant"><div class="font-claude-response"><p>Newer role answer.</p></div></article>', async () => {
        assert.equal((await run(readLatestReply, expected)).reply.text, 'Newer role answer.');
        await page.locator('article').evaluate(el => { el.removeAttribute('data-message-author-role'); el.dataset.testid = 'assistant-message'; });
        const r = await run(readLatestReply, expected); assert.equal(r.reply.text, 'Newer role answer.'); assert.ok(r.reply.id.startsWith('2:'));
      });
    await scenario('R2: retain paragraph/raw warning plus buttons beside pre; remove only pure language and button rows',
      '<article data-testid="assistant-message"><div class="standard-markdown"><div><p>Important: use a backup first.</p><button>More</button></div><div>Do not overwrite this warning.<button>More</button></div><div><span>Python</span><button>Copy</button></div><pre><code>run()</code></pre><div><button>Copy</button><button>More</button></div></div></article>', async () => {
        const before = await page.locator('body').innerHTML(); const r = await run(readLatestReply, expected);
        assert.ok(r.reply.text.includes('Important: use a backup first.')); assert.ok(r.reply.text.includes('Do not overwrite this warning.'));
        assert.ok(r.reply.text.includes('```Python\nrun()\n```')); assert.ok(!/More|Copy/.test(r.reply.text));
        assert.equal(r.reply.text.match(/Python/g).length, 1, 'language exists only in fence metadata');
        assert.equal(await page.locator('body').innerHTML(), before);
      });
    await scenario('R3: inline code exact-byte round trip for boundary ticks/runs/original whitespace',
      '<article data-testid="assistant-message"><p>Use <code></code> here.</p></article>', async () => {
        const values = ['`template`', '`start', 'end`', '``template``', '```', 'a``b`c', ' left', 'right ', ' both ', '  both  ', ' ', '   ', ' `template` ', '  ``template``  ', '\t`value`\t', 'first\nsecond'];
        for (const original of values) {
          await page.locator('article code').evaluate((el, value) => { el.textContent = value; }, original);
          const r = await run(readLatestReply, expected);
          const translated = await translateReplyText(r.reply.text, async text => text);
          const actual = await page.evaluate(({ parser, renderer, text }) => {
            const replyBlocks = eval(`(${parser})`);
            const renderReply = eval(`(${renderer})`);
            const target = document.createElement('div'); renderReply(target, text);
            return target.querySelector('code')?.textContent;
          }, { parser: replyBlocks.toString(), renderer: renderReply.toString(), text: translated.text });
          assert.equal(actual, original, `inline bytes for ${JSON.stringify(original)}`);
        }
      });

    // Load the actual sidebar module and CSS in the renderer; only APIs/model are simulated.
    await setup('<main><div class="ProseMirror" contenteditable="true"></div><article data-testid="assistant-message" data-message-id="one"><p>First answer.</p></article></main>');
    const target = { tabId: 1, windowId: 8, documentId: 'fixture-document', ...expected };
    const panel = await context.newPage();
    panel.on('pageerror', error => runtimeErrors.push(error.message));
    await panel.exposeFunction('__send', async message => {
      requests.push(message);
      if (message.type === 'TARGET') return { ok: true, target };
      if (message.type === 'READ_REPLY') return run(readLatestReply, expected);
      if (message.type === 'PREPARE') return run(claudeAdapter, { mode: 'prepare', expected });
      if (message.type === 'COMMIT') return run(claudeAdapter, { mode: 'commit', expected, text: message.text, token: message.token, replace: message.replace });
      if (message.type === 'CANCEL_FILL') return run(claudeAdapter, { mode: 'cancel', expected });
      throw Error('Unexpected message');
    });
    await panel.addInitScript(() => {
      const hook = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
      window.fixture = { memory: {}, creates: [], translations: [] };
      window.chrome = {
        runtime: { sendMessage: message => window.__send(message) },
        windows: { getCurrent: async () => ({ id: 8 }) }, tabs: { onActivated: hook(), onUpdated: hook(), onRemoved: hook() },
        storage: { session: {
          async get(key) { return key === null ? structuredClone(fixture.memory) : { [key]: fixture.memory[key] }; },
          async set(value) { Object.assign(fixture.memory, structuredClone(value)); },
          async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete fixture.memory[key]; }
        } }
      };
      window.Translator = { availability: async () => 'available', create(options) {
        fixture.creates.push({ from: options.sourceLanguage, to: options.targetLanguage, gesture: navigator.userActivation.isActive });
        return Promise.resolve({ translate: async body => {
          fixture.translations.push({ from: options.sourceLanguage, body });
          return options.sourceLanguage === 'en' ? `本地中文：${body}` : 'Explain recursion.';
        }, destroy() {} });
      } };
    });
    await panel.goto('https://panel.fixture.test/sidepanel.html');
    await panel.locator('#source').fill('解释递归'); await panel.locator('#translate').click();
    await panel.waitForFunction(() => document.querySelector('#output').value === 'Explain recursion.');
    await panel.locator('#fill').click();
    await panel.waitForFunction(() => document.querySelector('#actionStatus').textContent.includes('已填入'));
    const commit = requests.find(r => r.type === 'COMMIT'); assert.equal(commit.text, 'Explain recursion.');
    assert.equal(await page.locator('.ProseMirror').innerText(), 'Explain recursion.');
    await panel.locator('#output').fill('English `中文注释`');
    assert.equal(await panel.locator('#fill').isDisabled(), true);
    assert.match(await panel.locator('#boundaryStatus').innerText(), /第 1 行/);
    await panel.locator('#output').fill('Explain recursion.');
    results.push({ name: 'actual sidebar sends exactly the preview, no appended instructions, blocks Chinese before preparing', passed: true });

    await panel.locator('#readStart').click();
    await panel.waitForFunction(() => document.querySelector('#replyText').textContent.includes('本地中文：First answer.'), {}, { timeout: 12000 });
    await page.locator('main').evaluate(el => { const article = document.createElement('div'); article.className = 'font-claude-response'; article.dataset.messageId = 'two'; article.innerHTML = '<p>Second answer.</p>'; el.append(article); });
    await panel.waitForFunction(() => document.querySelector('#replyText').textContent.includes('本地中文：Second answer.'), {}, { timeout: 12000 });
    const enabled = await panel.evaluate(() => fixture.creates.filter(c => c.from === 'en'));
    assert.equal(enabled.length, 1); assert.equal(enabled[0].gesture, true);
    assert.ok(!(await page.locator('body').innerText()).includes('本地中文'));
    assert.ok(!JSON.stringify(requests).includes('本地中文')); assert.ok(!JSON.stringify(requests.filter(r => r.type !== 'TARGET')).includes('解释递归'));
    assert.ok(!await panel.evaluate(() => JSON.stringify(fixture.memory).includes('本地中文')));
    await panel.locator('#replyOriginalBox').evaluate(el => { el.open = true; });
    await panel.screenshot({ path: path.join(root, '.validation', 'sidepanel-0.2.0.png'), fullPage: true });
    results.push({ name: 'actual sidebar one enable gesture automatically translates two new replies, Chinese stays local and is not persisted', passed: true });
    const readsBeforePause = requests.filter(r => r.type === 'READ_REPLY').length;
    await panel.locator('#readPause').click();
    assert.equal(await panel.locator('#replyText').isHidden(), true);
    await panel.waitForTimeout(1800);
    assert.equal(requests.filter(r => r.type === 'READ_REPLY').length, readsBeforePause);
    results.push({ name: 'pause immediately clears reply UI and stops polling; no automatic messages sent', passed: true });
    // Exercise the real safe renderer independently of the mocked model's wording.
    await panel.evaluate(async () => {
      const { renderReply } = await import('./lib/reply-format.js');
      const code = 'def factorial(n):\n\n\n    return n\n';
      renderReply(document.querySelector('#replyText'), '## 阶乘示例\n\n调用 `factorial(3)`。\n\n- 基本情况\n\n```Python\n' + code + '\n```\n\n<script>window.injected=true</script>');
      document.querySelector('#replyText').hidden = false;
      window.renderExpected = code;
    });
    assert.equal(await panel.locator('#replyText .reply-code code').textContent(), await panel.evaluate(() => renderExpected));
    assert.equal(await panel.locator('#replyText .code-language').textContent(), 'Python');
    assert.equal(await panel.locator('#replyText h3').count(), 1); assert.equal(await panel.locator('#replyText .reply-item').count(), 1);
    assert.equal(await panel.evaluate(() => window.injected), undefined);
    assert.equal(await panel.locator('#replyText script').count(), 0);
    await panel.locator('#replyText').scrollIntoViewIfNeeded();
    await panel.screenshot({ path: path.join(root, '.validation', 'sidepanel-0.2.1.png'), fullPage: true });
    results.push({ name: 'safe readable headings/list/inline-code/language-labelled code; exact whitespace and no HTML execution', passed: true });
    assert.deepEqual(runtimeErrors, []);
    const report = { date: '2026-10-27', version: browser.version(), scope: 'Real Chrome renderer with local fixtures; sidebar Chrome APIs and Translator are mocked. Not live Claude/extension-source verification.', results, runtimeErrors };
    fs.writeFileSync(path.join(root, 'evidence', 'reading-browser-fixtures.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
