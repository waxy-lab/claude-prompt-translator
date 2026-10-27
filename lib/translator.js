import { hasChinese, splitProtected, translateProtected, validateSource } from './protected-text.js';
import { abortable } from './task-gate.js';

export async function availability(sourceLanguage, API = globalThis.Translator) {
  if (!API?.availability || !API?.create) return 'missing';
  return API.availability({ sourceLanguage, targetLanguage: 'en' });
}

// Called directly in the click handler; create() happens before any awaited work.
export async function translateDraft(text, sourceLanguage, { signal, onProgress = () => {}, API = globalThis.Translator }) {
  validateSource(text);
  const { spans } = splitProtected(text);
  if (!spans.some(s => s.kind === 'text' && hasChinese(s.text))) {
    return translateProtected(text, async s => s, () => signal.throwIfAborted());
  }
  if (!API?.create) throw new Error('此浏览器没有可用的 Chrome Translator API；草稿已保留，可稍后重试。');
  let translator;
  let timeout;
  const timeoutController = new AbortController();
  const combined = AbortSignal.any([signal, timeoutController.signal]);
  const destroy = () => { try { translator?.destroy(); } catch { /* Already destroyed. */ } };
  combined.addEventListener('abort', destroy, { once: true });
  timeout = setTimeout(() => timeoutController.abort(), 120000);
  try {
    const creating = API.create({
      sourceLanguage, targetLanguage: 'en', signal: combined,
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', e => {
          if (!combined.aborted) onProgress(Math.round(Math.max(0, Math.min(1, e.loaded)) * 100));
        });
      }
    });
    // Some implementations may finish create() after cancellation. Always dispose that instance.
    Promise.resolve(creating).then(t => { if (combined.aborted) { try { t.destroy(); } catch {} } }, () => {});
    translator = await abortable(creating, combined);
    clearTimeout(timeout);
    timeout = setTimeout(() => timeoutController.abort(), 60000);
    return await translateProtected(text, s => abortable(translator.translate(s, { signal: combined }), combined), () => combined.throwIfAborted());
  } catch (error) {
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    if (timeoutController.signal.aborted) throw new Error('本地引擎等待超时，已停止本次请求。请检查语言包状态后重试。');
    if (error.name === 'NotSupportedError') throw new Error('本机暂不支持所选中文到英文语言包，请检查引擎状态或换一种中文类型。');
    if (error.name === 'NotAllowedError') throw new Error('Chrome 未允许初始化本地引擎。请保持侧栏可见，再点击翻译；也可能受浏览器策略限制。');
    throw new Error('本地翻译失败，原文和上次结果已保留。请检查网络下载条件、Chrome 策略或语言包后重试。');
  } finally {
    clearTimeout(timeout);
    combined.removeEventListener('abort', destroy);
    destroy();
  }
}
