// Real local model comparison; no live Claude access. Run BEFORE replacing the 0.2.0 dist baseline.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const root = path.resolve(__dirname, '..');
  const baseline = process.env.QUALITY_BASELINE || path.join(root, 'dist', 'claude-english-assistant');
  if (JSON.parse(fs.readFileSync(path.join(baseline, 'manifest.json'), 'utf8')).version !== '0.2.0') throw Error('An intact 0.2.0 dist baseline is required');
  const profile = process.env.QUALITY_PROFILE ? path.resolve(process.env.QUALITY_PROFILE) : fs.mkdtempSync(path.join(root, '.validation', 'quality-model-'));
  if (!profile.startsWith(path.join(root, '.validation') + path.sep)) throw Error('Only project-owned isolated profiles are allowed');
  let browser, child;
  const allowed = new Set(['lib/reply-translator.js', 'lib/reply-text.js', 'lib/reply-format.js', 'lib/protected-text.js', 'lib/task-gate.js']);
  const samples = ['Calling `factorial(3)` unfolds like this:', 'Python', 'In Python, a missing base case can cause a `RecursionError`. Use memoization to avoid recalculating results.'];
  const markerSamples = process.env.QUALITY_MARKERS ? ['Calling ZXQKEEP0QXZ unfolds like this:', 'Calling CPT_KEEP_0 unfolds like this:', 'Calling `CPT_KEEP_0` unfolds like this:', 'Calling CPT_FUNCTION_0() unfolds like this:', 'Calling __CPT_KEEP_0__ unfolds like this:'] : [];
  const server = http.createServer((req, res) => {
    const requestPath = new URL(req.url, 'http://localhost').pathname;
    if (requestPath !== '/') {
      const old = requestPath.startsWith('/old/'), name = requestPath.replace(/^\/(?:old|new)\//, '');
      if (!allowed.has(name)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(old ? baseline : root, name))); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Local translation quality comparison</title><button id="start">Compare local pipelines</button><pre id="output"></pre><script type="module">
      import {ReplyTranslator as Old} from '/old/lib/reply-translator.js';
      import {ReplyTranslator as New} from '/new/lib/reply-translator.js';
      window.probe={api:typeof Translator,samples:[]};
      start.onclick=async()=>{start.disabled=true;const old=new Old(),fresh=new New();const signal=new AbortController().signal;let model;
        try {
          model=await Translator.create({sourceLanguage:'en',targetLanguage:'zh'});
          probe.markerDiagnostics=[];
          for(const source of ${JSON.stringify(markerSamples)}) probe.markerDiagnostics.push({source,result:await model.translate(source)});
          // One real model creation per gesture; both pipelines use the same real model.
          const API={create:async()=>({translate:(body,options)=>model.translate(body,options),destroy(){}})};
          await Promise.all([old.enable({signal,API}),fresh.enable({signal,API})]);
          for(const source of ${JSON.stringify(samples)}) {
            const item={source};probe.samples.push(item);item.old=await old.translate(source,signal);item.updated=await fresh.translate(source,signal);output.textContent=JSON.stringify(probe,null,2);
          }
        }catch(e){probe.error=e.name+': '+e.message}finally{old.destroy();fresh.destroy();model?.destroy();probe.finished=true;output.textContent=JSON.stringify(probe,null,2)}
      };
    </script>`);
  });
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const startedAt = Date.now();
    child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', `http://127.0.0.1:${server.address().port}`], { windowsHide: true, stdio: 'ignore' });
    let port;
    for (let i = 0; i < 150; i++) { try { const file = path.join(profile, 'DevToolsActivePort'); if (fs.statSync(file).mtimeMs >= startedAt - 1000) { port = fs.readFileSync(file, 'utf8').split('\n')[0]; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
    if (!port) throw Error('Isolated Chrome did not start');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts()[0].pages()[0]; await page.waitForSelector('#start');
    await page.waitForFunction(() => !!window.probe); await page.click('#start');
    console.log('Real local model comparison started (up to 150 seconds).');
    let timedOut = false;
    await page.waitForFunction(() => window.probe.finished, {}, { timeout: 150000 }).catch(() => { timedOut = true; });
    const report = { date: '2026-10-27', version: browser.version(), timedOut, scope: 'Real Chrome Translator shared by 0.2.0 and updated pipelines via an API wrapper; ordinary localhost. Not two independent model initializations, live Claude, or a translation benchmark.', probe: await page.evaluate(() => window.probe) };
    fs.writeFileSync(path.join(root, 'evidence', 'quality-model-0.2.1.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } finally {
    try { if (browser) { const session = await browser.newBrowserCDPSession(); await session.send('Browser.close').catch(() => {}); } } catch {}
    child?.kill(); server.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
