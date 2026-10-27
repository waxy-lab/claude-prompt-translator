// Optional real model comparison on a public localhost page, never live Claude.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { execFileSync, spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const root = path.resolve(__dirname, '..'), base = 'cd8095932ee1141eb6f08ae96a9b510ff6240a3e';
  const profile = process.env.LANGUAGE_PROFILE ? path.resolve(process.env.LANGUAGE_PROFILE) : fs.mkdtempSync(path.join(root, '.validation', 'language-model-'));
  if (!profile.startsWith(path.join(root, '.validation') + path.sep)) throw Error('Only project-owned isolated profiles are allowed');
  const names = ['lib/reply-translator.js', 'lib/reply-text.js', 'lib/reply-format.js', 'lib/protected-text.js', 'lib/task-gate.js'];
  const oldFiles = Object.fromEntries(names.map(name => [name, execFileSync('git', ['show', base + ':' + name], { cwd: root, encoding: 'utf8' })]));
  const samples = ['This python function returns a value.', 'In PYTHON, a recursive function calls itself.', 'A python is a large snake.', 'python'];
  let browser, child;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname !== '/') {
      const old = pathname.startsWith('/old/'), name = pathname.replace(/^\/(?:old|new)\//, '');
      if (!names.includes(name)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', 'text/javascript'); res.end(old ? oldFiles[name] : fs.readFileSync(path.join(root, name))); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Public Python language comparison</title><button id="start">Compare</button><pre id="output"></pre><script type="module">
      import {ReplyTranslator as Old} from '/old/lib/reply-translator.js';
      import {ReplyTranslator as New} from '/new/lib/reply-translator.js';
      window.probe={api:typeof Translator,samples:[],calls:[]};
      start.onclick=async()=>{start.disabled=true;const old=new Old(),fresh=new New();const signal=new AbortController().signal;let model;
        try {
          model=await Translator.create({sourceLanguage:'en',targetLanguage:'zh'});
          const API=label=>({create:async()=>({translate:async(body,options)=>{probe.calls.push({pipeline:label,body});return model.translate(body,options)},destroy(){}})});
          await old.enable({signal,API:API('0.2.3')});await fresh.enable({signal,API:API('0.2.4')});
          for(const source of ${JSON.stringify(samples)}) {const item={source};probe.samples.push(item);item.old=await old.translate(source,signal);item.updated=await fresh.translate(source,signal);}
        }catch(e){probe.error=e.name+': '+e.message}finally{old.destroy();fresh.destroy();model?.destroy();probe.finished=true;output.textContent=JSON.stringify(probe,null,2)}
      };
    </script>`);
  });
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r)); const started = Date.now();
    child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', `http://127.0.0.1:${server.address().port}`], { windowsHide: true, stdio: 'ignore' });
    let port;
    for (let i = 0; i < 150; i++) { try { const file = path.join(profile, 'DevToolsActivePort'); if (fs.statSync(file).mtimeMs >= started - 1000) { port = fs.readFileSync(file, 'utf8').split('\n')[0]; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
    if (!port) throw Error('Isolated Chrome did not start');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts()[0].pages()[0]; await page.waitForFunction(() => !!window.probe); await page.click('#start');
    console.log('Public real-model comparison started (up to 150 seconds).'); let timedOut = false;
    await page.waitForFunction(() => window.probe.finished, {}, { timeout: 150000 }).catch(() => { timedOut = true; });
    const report = { date: '2026-10-27', browser: browser.version(), base, timedOut, scope: 'Real Chrome Translator shared by old/new pipelines on localhost; public samples only. Not extension-source or live Claude verification.', probe: await page.evaluate(() => window.probe) };
    fs.writeFileSync(path.join(root, 'evidence', 'language-model-0.2.4.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    try { if (browser) { const session = await browser.newBrowserCDPSession(); await session.send('Browser.close').catch(() => {}); } } catch {}
    child?.kill(); server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
