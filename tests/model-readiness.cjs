// Development probe only: new isolated Chrome, local page, two public samples, one click.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const root = path.resolve(__dirname, '..');
  fs.mkdirSync(path.join(root, '.validation'), { recursive: true });
  const profile = fs.mkdtempSync(path.join(root, '.validation', 'reply-model-'));
  let browser, child;
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Local reply model test</title><button id="start">Check en to zh</button><pre id="output"></pre><script>
      window.probe={secure:isSecureContext,api:typeof Translator,samples:[],progress:[]};
      start.onclick=async()=>{start.disabled=true;let t;try {
        if(!window.Translator)throw Error('Translator API missing');
        probe.availability=await Translator.availability({sourceLanguage:'en',targetLanguage:'zh'});
        t=await Translator.create({sourceLanguage:'en',targetLanguage:'zh',monitor(m){m.addEventListener('downloadprogress',e=>probe.progress.push(e.loaded))}});
        for(const source of ['Recursion solves a problem by calling itself.','A base case stops the recursion.']) probe.samples.push({source,result:await t.translate(source)});
      }catch(e){probe.error=e.name+': '+e.message}finally{t?.destroy();probe.finished=true;output.textContent=JSON.stringify(probe,null,2)}};
    </script>`);
  });
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', `http://127.0.0.1:${server.address().port}`], { windowsHide: true, stdio: 'ignore' });
    let port;
    for (let i = 0; i < 150; i++) {
      try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    if (!port) throw Error('Isolated Chrome did not start');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts()[0].pages()[0];
    await page.waitForSelector('#start'); await page.click('#start');
    console.log('Isolated model probe started; waiting up to 120 seconds.');
    let timedOut = false;
    await page.waitForFunction(() => window.probe.finished, {}, { timeout: 120000 }).catch(() => { timedOut = true; });
    const result = { date: '2026-10-27', version: browser.version(), timedOut, probe: await page.evaluate(() => window.probe), scope: 'Localhost ordinary document; not extension source or live Claude.' };
    fs.writeFileSync(path.join(root, 'evidence', 'local-model-0.2.0.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    try { if (browser) { const client = await browser.newBrowserCDPSession(); await client.send('Browser.close').catch(() => {}); } } catch {}
    child?.kill(); server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
