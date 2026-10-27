// Real Chrome renderer tests against INTERCEPTED local fixtures, never the live Claude service.
// Development-only: point PLAYWRIGHT_MODULE to an existing Playwright installation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const root = path.resolve(__dirname, '..');
  const { claudeAdapter } = await import('../content/claude-adapter.js');
  const { captureIdentity } = await import('../lib/target.js');
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const results = [];
  try {
    const context = await browser.newContext();
    let markup = '';
    // Every request is intercepted. No live Claude requests or messages are made.
    await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><style>[contenteditable],textarea{display:block;width:400px;min-height:80px}</style>' + markup }));
    const page = await context.newPage();
    async function setup(body) {
      markup = body;
      await page.goto('https://claude.ai/new');
      return page.evaluate(`(${captureIdentity.toString()})()`);
    }
    const adapter = (expected, request) => page.evaluate(({ source, expected, request }) =>
      (new Function(`return (${source})`))()({ expected, ...request }), { source: claudeAdapter.toString(), expected, request });
    async function scenario(name, body, verify) {
      const expected = await setup(body); assert.ok(expected, 'Identity captured');
      await verify(expected); results.push({ name, passed: true });
    }
    await scenario('form-free ProseMirror, no main ancestor, plain text insertion', '<div class="tiptap ProseMirror" contenteditable="true"><p><br></p></div>', async expected => {
      const p = await adapter(expected, { mode: 'prepare' }); assert.equal(p.ok, true); assert.equal(p.nonempty, false);
      assert.equal((await adapter(expected, { mode: 'commit', token: p.token, text: 'Explain recursion with simple examples.' })).ok, true);
      assert.equal(await page.locator('.ProseMirror').innerText(), 'Explain recursion with simple examples.');
    });
    await scenario('explicit chat-input outside form and guarded replacement', '<div id="chat-input" contenteditable="true">Existing draft</div>', async expected => {
      let p = await adapter(expected, { mode: 'prepare' }); assert.equal(p.nonempty, true);
      assert.equal((await adapter(expected, { mode: 'commit', token: p.token, text: 'New' })).ok, false);
      assert.equal(await page.locator('#chat-input').innerText(), 'Existing draft');
      p = await adapter(expected, { mode: 'prepare' });
      assert.equal((await adapter(expected, { mode: 'commit', token: p.token, replace: true, text: 'New' })).ok, true);
    });
    await scenario('arbitrary contenteditable and search textbox are rejected', '<main><div contenteditable="true" role="textbox">Unrelated editor</div></main><div role="search"><div id="chat-input" contenteditable="true">Search</div></div>', async expected => {
      assert.equal((await adapter(expected, { mode: 'prepare' })).code, 'EDITOR_AMBIGUOUS');
    });
    await scenario('multiple known visible editors are rejected', '<div class="ProseMirror" contenteditable="true"></div><div class="ProseMirror" contenteditable="true"></div>', async expected => {
      const p = await adapter(expected, { mode: 'prepare' }); assert.equal(p.ok, false); assert.match(p.message, /2 个/);
    });
    await scenario('hidden and artifact editors excluded, visible composer chosen', '<div hidden><div class="ProseMirror" contenteditable="true">Hidden</div></div><aside><div class="ProseMirror" contenteditable="true">Artifact</div></aside><div class="ProseMirror" contenteditable="true"></div>', async expected => {
      const p = await adapter(expected, { mode: 'prepare' }); assert.equal(p.ok, true);
      assert.equal((await adapter(expected, { mode: 'commit', token: p.token, text: 'Only the composer' })).ok, true);
      assert.equal(await page.locator('aside .ProseMirror').innerText(), 'Artifact');
    });
    await scenario('DOM edit after confirmation prevents overwrite', '<div class="ProseMirror" contenteditable="true">Old</div>', async expected => {
      const p = await adapter(expected, { mode: 'prepare' });
      await page.locator('.ProseMirror').fill('User changed this');
      assert.equal((await adapter(expected, { mode: 'commit', token: p.token, replace: true, text: 'New' })).code, 'DRAFT_CHANGED');
      assert.equal(await page.locator('.ProseMirror').innerText(), 'User changed this');
    });
    const report = { date: '2026-10-27', version: browser.version(), scope: 'Real Chrome DOM with intercepted local fixtures. NOT live Claude compatibility or extension loading.', results };
    fs.writeFileSync(path.join(root, 'evidence', 'browser-fixtures.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
