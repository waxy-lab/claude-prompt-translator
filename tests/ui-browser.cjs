// UI acceptance in a real isolated Chrome renderer. Only public fixtures; APIs/models mocked.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
(async () => {
  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'evidence', 'ui-0.2.3'); fs.mkdirSync(out, { recursive: true });
  const code = 'def factorial(n):\n\n    # <img src="https://assets.example.test/no-load.png" onerror="window.injected=1">\n    return "' + 'x'.repeat(140) + '"\n';
  const url = 'https://example.test/docs/' + 'long-path-'.repeat(24) + '?q=one&mode=two';
  const sample = '## Recursion in practice\n\nA function calls itself on a smaller problem. Use `` `template` `` and `factorial(3)` for comparison.\n\n- Define a base case.\n\n- Reduce the problem.\n\n```Python\n' + code + '\n```\n\nDocumentation <' + url + '>\n\nLiteral HTML: <script>window.injected=1</script> <img src="https://assets.example.test/no-load.png">. No external content should load.';
  const reply = text => ({ ok: true, reply: { id: 'public-answer', text, stableText: text, streaming: false } });
  let replyResult = reply(sample), nonempty = false;
  const requests = [], resourceRequests = [], errors = [], shots = [], checks = [];
  const files = new Set(['sidepanel.html', 'sidepanel.css', 'sidepanel.js', ...fs.readdirSync(path.join(root, 'lib')).filter(n => n.endsWith('.js')).map(n => 'lib/' + n)]);
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 400, height: 900 }, colorScheme: 'light' });
    await context.route('**/*', route => {
      const request = new URL(route.request().url()), name = request.pathname.slice(1);
      if (request.hostname === 'ui.fixture.test' && files.has(name)) return route.fulfill({ body: fs.readFileSync(path.join(root, name)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', headers: { 'Content-Security-Policy': "script-src 'self'; object-src 'none'; connect-src 'none'" } });
      resourceRequests.push(route.request().url()); return route.fulfill({ status: 404, body: 'No external resources' });
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.exposeFunction('__send', async message => {
      requests.push(message);
      if (message.type === 'TARGET') return { ok: true, target: { tabId: 1, windowId: 8, href: 'https://claude.ai/chat/public-fixture', documentId: 'public', nonce: 'public', revision: 0 } };
      if (message.type === 'READ_REPLY') return replyResult;
      if (message.type === 'PREPARE') return { ok: true, token: 'confirmation', nonempty };
      return { ok: true };
    });
    await page.addInitScript(() => {
      const hook = () => ({ addListener() {} });
      window.fixture = { memory: {}, creates: [], copies: [], setupPending: false, setupFail: false, questionPending: false, questionFail: false, copyFail: false, translations: [] };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(value) { if (fixture.copyFail) throw Error('Denied in fixture'); fixture.copies.push(value); } } });
      window.chrome = { runtime: { sendMessage: value => window.__send(value) }, windows: { getCurrent: async () => ({ id: 8 }) }, tabs: { onActivated: hook(), onUpdated: hook(), onRemoved: hook() }, storage: { session: {
        async get(key) { return key === null ? structuredClone(fixture.memory) : { [key]: fixture.memory[key] }; },
        async set(value) { Object.assign(fixture.memory, structuredClone(value)); }, async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete fixture.memory[key]; }
      } } };
      const instance = options => ({ destroy() {}, async translate(body) {
        fixture.translations.push({ from: options.sourceLanguage, body });
        if (options.sourceLanguage === 'zh') {
          if (fixture.questionFail) throw Error('Question failure');
          if (fixture.questionPending) return new Promise(resolve => { fixture.resolveQuestion = () => { fixture.questionPending = false; resolve('Explain recursion.'); }; });
          return 'Explain recursion.';
        }
        return `译文：${body}`;
      } });
      window.Translator = { availability: async () => 'available', create(options) {
        fixture.creates.push({ from: options.sourceLanguage, gesture: navigator.userActivation.isActive });
        if (options.sourceLanguage === 'en') {
          if (fixture.setupFail) return Promise.reject(new DOMException('Unsupported fixture', 'NotSupportedError'));
          if (fixture.setupPending) {
            options.monitor?.({ addEventListener(_name, fn) { fn({ loaded: .42 }); } });
            return new Promise(resolve => { fixture.resolveSetup = () => { fixture.setupPending = false; resolve(instance(options)); }; });
          }
        }
        return Promise.resolve(instance(options));
      } };
    });
    await page.goto('https://ui.fixture.test/sidepanel.html');
    await page.waitForFunction(() => !document.querySelector('#source').disabled);
    async function shot(name, scenario) {
      await page.evaluate(() => window.scrollTo(0, 0));
      const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
      assert.ok(overflow.scroll <= overflow.viewport + 1, `${name}: page overflows ${JSON.stringify(overflow)}`);
      const file = path.join(out, name + '.png'); await page.screenshot({ path: file, fullPage: true });
      shots.push({ name, file: path.relative(root, file).replaceAll('\\', '/'), scenario, width: page.viewportSize().width, theme: await page.evaluate(() => matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), overflow });
    }
    await page.locator('#readingTab').click();
    assert.equal(await page.locator('#readingEmpty').isVisible(), true);
    await shot('empty-light-400', '未开启阅读的空状态');

    // User gesture and preparation state; switching workspace never cancels it.
    await page.evaluate(() => { fixture.setupPending = true; });
    await page.locator('#readStart').click();
    await page.waitForFunction(() => document.querySelector('#readStatus').textContent.includes('42%'));
    await shot('preparing-light-400', '英译中语言包准备进度与取消按钮');
    await page.locator('#askTab').click();
    assert.equal(await page.locator('#readerIndicator').textContent(), '阅读准备中');
    await page.evaluate(() => fixture.resolveSetup());
    await page.waitForFunction(() => document.querySelector('#replyText').textContent.includes('译文：Recursion in practice'), {}, { timeout: 12000 });
    assert.equal(await page.locator('#readerIndicator').textContent(), '自动阅读中');
    await page.locator('#source').fill('解释递归'); await page.locator('#translate').click();
    await page.waitForFunction(() => document.querySelector('#output').value === 'Explain recursion.');
    const draftBefore = await page.locator('#source').inputValue(), outputBefore = await page.locator('#output').inputValue();
    const memoryBefore = await page.evaluate(() => JSON.stringify(fixture.memory));

    // Keyboard: roving tabs, selection/hidden states and visible focus ring.
    await page.locator('#askTab').focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#readingTab').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#askPanel').isHidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'readingTab');
    const focus = await page.locator('#readingTab').evaluate(el => ({ visible: el.matches(':focus-visible'), style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth }));
    assert.equal(focus.visible, true); assert.notEqual(focus.style, 'none'); assert.notEqual(focus.width, '0px');
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'readPause');
    checks.push({ name: 'keyboard roving tabs, Tab order and visible focus', passed: true, focus });

    await page.locator('#originalTab').click();
    assert.equal(await page.locator('#originalReadMode').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#replyOriginalText').isHidden(), true);
    assert.equal(await page.locator('#replyOriginal h3').textContent(), 'Recursion in practice');
    assert.equal(await page.locator('#replyOriginal .reply-item').count(), 2);
    assert.equal(await page.locator('#replyOriginal .reply-code code').textContent(), code);
    assert.equal(await page.locator('#replyOriginal .code-language').textContent(), 'Python');
    assert.equal(await page.locator('#replyOriginal p code').first().textContent(), '`template`');
    assert.equal(await page.locator('#replyOriginal .reply-url').textContent(), url);
    assert.ok(!(await page.locator('#replyOriginal').textContent()).includes('```'));
    await page.locator('#copyOriginal').click();
    assert.equal(await page.evaluate(() => fixture.copies.at(-1)), sample);
    await page.locator('#originalTextMode').click();
    assert.equal(await page.locator('#replyOriginalText').textContent(), sample);
    assert.equal(await page.locator('#replyOriginal').isHidden(), true);
    await page.locator('#copyOriginal').click(); assert.equal(await page.evaluate(() => fixture.copies.at(-1)), sample);
    await page.evaluate(() => { fixture.copyFail = true; }); await page.locator('#copyOriginal').click();
    assert.equal(await page.evaluate(() => getSelection().toString()), sample);
    await page.evaluate(() => { fixture.copyFail = false; });
    await page.locator('#originalReadMode').click();
    checks.push({ name: 'English defaults to shared reading layout, raw view/copy exact, clipboard rejection selects exact raw text', passed: true });

    const updated = sample + '\n\nThe next reply arrived while asking.';
    await page.locator('#askTab').click(); replyResult = { ...reply(updated), reply: { ...reply(updated).reply, id: 'next-public-answer' } };
    await page.waitForFunction(() => document.querySelector('#replyOriginalText').textContent.includes('next reply arrived'), {}, { timeout: 12000 });
    await page.waitForFunction(() => document.querySelector('#replyText').textContent.includes('next reply arrived'), {}, { timeout: 12000 });
    assert.equal(await page.locator('#source').inputValue(), draftBefore); assert.equal(await page.locator('#output').inputValue(), outputBefore);
    assert.equal(await page.evaluate(() => fixture.creates.filter(c => c.from === 'en').length), 1);
    assert.equal(await page.evaluate(() => JSON.stringify(fixture.memory)), memoryBefore);
    assert.ok(!JSON.stringify(requests).includes('译文：'));
    checks.push({ name: 'workspace/language/format switches keep drafts, translation, same target and one running reader instance', passed: true });

    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [320, 400, 600]) {
        await page.setViewportSize({ width, height: 900 }); await page.locator('#readingTab').click(); await page.locator('#originalTab').click(); await page.locator('#originalReadMode').click();
        await shot(`original-${theme}-${width}`, '英文默认阅读视图，长 URL 换行，代码横向滚动');
        const scroll = await page.locator('#replyOriginal .reply-code pre').evaluate(el => ({ scroll: el.scrollWidth, viewport: el.clientWidth, keyboard: el.tabIndex }));
        assert.ok(scroll.scroll > scroll.viewport); assert.equal(scroll.keyboard, 0);
      }
      await page.setViewportSize({ width: 400, height: 900 }); await page.locator('#translatedTab').click();
      await shot(`translated-${theme}-400`, '中文译文与英文共用安全排版');
    }
    await page.emulateMedia({ colorScheme: 'light' }); await page.setViewportSize({ width: 320, height: 900 }); await page.locator('#askTab').click(); await shot('ask-light-320', '窄屏提问区与可达主按钮');
    await page.emulateMedia({ colorScheme: 'dark' }); await page.setViewportSize({ width: 600, height: 900 }); await shot('ask-dark-600', '深色宽屏提问区');
    checks.push({ name: '320/400/600 light and dark: no page horizontal overflow, code scroll and keyboard entry', passed: true });

    await page.emulateMedia({ colorScheme: 'light' }); await page.setViewportSize({ width: 400, height: 900 });
    nonempty = true; await page.locator('#fill').click(); assert.equal(await page.locator('#replaceBox').isVisible(), true);
    await shot('confirm-light-400', '替换确认与取消按钮');
    await page.locator('#readingTab').click(); assert.equal(await page.locator('#crossNotice').isVisible(), true);
    assert.match(await page.locator('#crossStatus').textContent(), /确认/);
    await page.locator('#returnPrompt').click(); assert.equal(await page.evaluate(() => document.activeElement.id), 'replace');
    await page.locator('#keep').click(); assert.equal(requests.filter(r => r.type === 'COMMIT').length, 0);
    await page.locator('#output').fill('Explain `中文`');
    assert.equal(await page.locator('#fill').isDisabled(), true); await shot('boundary-light-400', '汉字边界拦截与位置提示');
    await page.locator('#readingTab').click(); assert.equal(await page.locator('#crossNotice').isVisible(), true);
    await page.locator('#returnPrompt').click(); assert.equal(await page.evaluate(() => document.activeElement.id), 'output');
    await page.locator('#output').fill('Explain recursion.');
    checks.push({ name: 'pending replacement and character boundary remain visible across workspace switch without sending', passed: true });

    await page.evaluate(() => { fixture.questionPending = true; }); await page.locator('#translate').click();
    await shot('question-loading-light-400', '提问翻译进行中与取消入口');
    await page.locator('#readingTab').click(); assert.equal(await page.locator('#promptFlag').textContent(), '翻译中');
    await page.evaluate(() => fixture.resolveQuestion());
    await page.locator('#askTab').click(); await page.evaluate(() => { fixture.questionFail = true; }); await page.locator('#translate').click();
    await page.waitForFunction(() => document.querySelector('#taskStatus').textContent.includes('失败'));
    await page.locator('#readingTab').click(); assert.equal(await page.locator('#crossNotice').isVisible(), true);
    await shot('question-error-light-400', '另一分区可见的提问失败提示');
    checks.push({ name: 'question loading/error states survive view switches; hidden-pane errors have visible return entry', passed: true });

    await page.locator('#readPause').click(); assert.equal(await page.locator('#readingEmpty').isVisible(), true);
    await page.evaluate(() => { fixture.setupFail = true; }); await page.locator('#readStart').click();
    await page.waitForFunction(() => document.querySelector('#readerIndicator').textContent.includes('需重试'));
    await shot('reader-error-light-400', '阅读初始化失败、状态及重试入口');
    assert.equal(await page.locator('#readStart').isEnabled(), true);
    const hover = await page.locator('#readStart').evaluate(node => { const style = getComputedStyle(node); return { background: style.backgroundColor, expected: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() }; });
    assert.equal(hover.background, 'rgb(141, 78, 56)', 'hover keeps the primary background and readable text');
    checks.push({ name: 'reading pause/error clears memory and exposes retry; view switches alone never pause', passed: true });

    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.locator('#replyOriginal a,#replyOriginal img,#replyOriginal script,#replyOriginal iframe').count(), 0);
    assert.deepEqual(resourceRequests, []); assert.deepEqual(errors, []);
    checks.push({ name: 'model text/URL/HTML never creates executable tags, clickable links or external resource requests', passed: true });
    const report = { date: '2026-10-27', browser: browser.version(), scope: 'Real Chrome UI renderer. Public fixture content; extension APIs, model, clipboard and errors mocked. Not live Claude/real clipboard.', checks, screenshots: shots, resourceRequests, runtimeErrors: errors };
    fs.writeFileSync(path.join(root, 'evidence', 'ui-0.2.3.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ checks: checks.length, screenshots: shots.length, resourceRequests, runtimeErrors: errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
