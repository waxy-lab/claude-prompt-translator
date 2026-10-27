// Development-only check. Uses the existing local Chrome and a NEW isolated profile.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
let activeBrowser, activeChild, activeServer;
async function cleanup() {
  try { if (activeBrowser) { const client = await activeBrowser.newBrowserCDPSession(); await client.send('Browser.close').catch(() => {}); } } catch {}
  activeChild?.kill(); activeServer?.close();
}
(async () => {
  const root = path.resolve(__dirname, '..');
  fs.mkdirSync(path.join(root, '.validation'), { recursive: true });
  const profile = fs.mkdtempSync(path.join(root, '.validation', 'chrome-probe-'));
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Translator feasibility — isolated test</title><button id="run">Test local Chinese to English</button><pre id="out"></pre><script>
    window.result={ua:navigator.userAgent,secure:isSecureContext,api:typeof Translator};
    (async()=>{if(window.Translator) for(const sourceLanguage of ['zh','zh-Hant']) {try{result[sourceLanguage]=await Translator.availability({sourceLanguage,targetLanguage:'en'})}catch(e){result[sourceLanguage]=e.name+': '+e.message}}out.textContent=JSON.stringify(result,null,2)})();
    run.onclick=async()=>{run.disabled=true;run.onclick=null;result.started=true;try{let t=await Translator.create({sourceLanguage:'zh',targetLanguage:'en',monitor(m){m.addEventListener('downloadprogress',e=>{result.progress=e.loaded;out.textContent=JSON.stringify(result,null,2)})}});result.translation=await t.translate('请解释这段代码。');t.destroy()}catch(e){result.error=e.name+': '+e.message}result.finished=true;out.textContent=JSON.stringify(result,null,2)};
    </script>`);
  });
  activeServer = server;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    `http://127.0.0.1:${server.address().port}`
  ], { windowsHide: true, stdio: 'ignore' });
  activeChild = child;
  child.on('error', () => {});
  let port;
  for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break}catch{}await new Promise(r=>setTimeout(r,100))}
  if(!port){child.kill();server.close();throw new Error('隔离 Chrome 启动失败，未读取日常配置。')}
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  activeBrowser = browser;
  const page=browser.contexts()[0].pages()[0];
  await page.waitForSelector('#run');
  await page.waitForFunction(()=>!window.Translator || !!window.result.zh);
  const before=await page.evaluate(()=>window.result);
  await page.click('#run');
  await page.waitForFunction(()=>window.result.finished,{},{timeout:60000}).catch(()=>{});
  const result={version:browser.version(),before,after:await page.evaluate(()=>window.result)};
  fs.writeFileSync(path.join(root,'.validation','feasibility.latest.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  await cleanup();
})().catch(async e=>{console.error(e);await cleanup();process.exitCode=1});
