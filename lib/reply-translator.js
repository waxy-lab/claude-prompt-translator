import { translateReplyText } from './reply-text.js';
import { abortable } from './task-gate.js';

// One instance per enabled reading session. No storage, worker model, or network fallback.
export class ReplyTranslator {
  #instance;
  #lifetime;
  #cache = new Map();
  #cacheSize = 0;
  #generation = 0;
  constructor({ setupTimeout = 120000, translateTimeout = 60000, cacheLimit = 100000 } = {}) {
    this.setupTimeout = setupTimeout; this.translateTimeout = translateTimeout; this.cacheLimit = cacheLimit;
  }
  async enable({ signal, onProgress = () => {}, API = globalThis.Translator } = {}) {
    this.destroy();
    if (!API?.create) throw new Error('此浏览器没有可用的本地翻译引擎。');
    const generation = this.#generation;
    const lifetime = this.#lifetime = new AbortController();
    const timerController = new AbortController();
    const combined = AbortSignal.any([lifetime.signal, timerController.signal, ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    const timeout = setTimeout(() => timerController.abort(), this.setupTimeout);
    try {
      // Keep create before the first await, in the direct user click chain.
      const creating = API.create({ sourceLanguage: 'en', targetLanguage: 'zh', signal: combined,
        monitor(m) { m.addEventListener('downloadprogress', e => {
          if (!combined.aborted && Number.isFinite(e.loaded)) onProgress(Math.round(Math.max(0, Math.min(1, e.loaded)) * 100));
        }); }
      });
      Promise.resolve(creating).then(t => {
        if (combined.aborted || generation !== this.#generation) { try { t.destroy(); } catch {} }
      }, () => {});
      const instance = await abortable(creating, combined);
      combined.throwIfAborted();
      if (generation !== this.#generation) throw new DOMException('已取消', 'AbortError');
      this.#instance = instance;
    } catch (error) {
      if (signal?.aborted || lifetime.signal.aborted) throw new DOMException('已取消', 'AbortError');
      if (timerController.signal.aborted) throw new Error('英译中语言包准备超时，请保持侧栏可见，稍后重试。');
      if (error.name === 'NotAllowedError') throw new Error('请保持侧栏可见，再点击开启自动中文阅读。');
      throw new Error('英译中引擎未就绪，请检查语言包后重试；不会改用云翻译。');
    } finally { clearTimeout(timeout); }
  }
  async translate(text, signal) {
    const instance = this.#instance, generation = this.#generation;
    if (!instance || !this.#lifetime) throw new Error('请先开启自动中文阅读。');
    const timerController = new AbortController();
    const combined = AbortSignal.any([this.#lifetime.signal, timerController.signal, signal]);
    const timeout = setTimeout(() => timerController.abort(), this.translateTimeout);
    const check = () => {
      combined.throwIfAborted();
      if (generation !== this.#generation) throw new DOMException('已取消', 'AbortError');
    };
    try {
      return await translateReplyText(text, async (body, { validate = value => typeof value === 'string' && value.trim() && !/[\r\n]/.test(value.trim()), protectedTemplate = false } = {}) => {
        check();
        if (protectedTemplate && this.#cache.has(body) && this.#cache.get(body) === null) return '';
        if (this.#cache.has(body) && validate(this.#cache.get(body))) return this.#cache.get(body);
        const result = await abortable(instance.translate(body, { signal: combined }), combined);
        check();
        if (validate(result) || protectedTemplate) {
          const cached = validate(result) ? result : null; // remember rejected templates, never their corrupted output
          const size = body.length + (cached?.length || 0);
          if (size <= this.cacheLimit) {
            if (this.#cache.has(body)) {
              this.#cacheSize -= body.length + (this.#cache.get(body)?.length || 0);
              this.#cache.delete(body);
            }
            while (this.#cache.size && this.#cacheSize + size > this.cacheLimit) {
              const [old, value] = this.#cache.entries().next().value;
              this.#cache.delete(old); this.#cacheSize -= old.length + (value?.length || 0);
            }
            this.#cache.set(body, cached); this.#cacheSize += size;
          }
        }
        return result;
      }, check);
    } catch (error) {
      if (signal.aborted || generation !== this.#generation) throw new DOMException('已取消', 'AbortError');
      if (timerController.signal.aborted) throw new Error('回复翻译超时，英文保留在网页；请重试自动阅读。');
      if (error.name === 'AbortError') throw error;
      throw new Error(`回复翻译未完成：${error.message || '本地引擎失败'}。未发布本次部分结果。`);
    } finally { clearTimeout(timeout); }
  }
  clearCache() { this.#cache.clear(); this.#cacheSize = 0; }
  destroy() {
    this.#generation++;
    this.#lifetime?.abort(); this.#lifetime = null;
    try { this.#instance?.destroy(); } catch {}
    this.#instance = null; this.clearCache();
  }
}
