import { ReplyTranslator } from './reply-translator.js';
import { TaskGate, abortable } from './task-gate.js';

// Pure coordinator. Caller ticks poll only while its side panel is visible.
export class AutoReader {
  #life = new TaskGate();
  #work = new TaskGate();
  #session;
  #reading;
  #observation;
  #inflight;
  #completed;
  constructor({ read, onChange = () => {}, translator = new ReplyTranslator(), clock = Date.now, settleMs = 1500, readTimeout = 10000 }) {
    this.read = read; this.onChange = onChange; this.translator = translator;
    this.clock = clock; this.settleMs = settleMs; this.readTimeout = readTimeout;
    this.state = { enabled: false, phase: 'off', original: '', translation: '', message: '开启后自动读取当前会话最新助手回复，中文仅显示在侧栏。', warnings: [] };
  }
  #emit(patch) { Object.assign(this.state, patch); this.onChange({ ...this.state }); }
  stop(message = '已暂停并清除回复内存。重新开启后自动读取当前最新回复。') {
    this.#life.cancel(); this.#work.cancel(); this.translator.destroy();
    this.#session = null; this.#reading = null; this.#observation = null; this.#inflight = null; this.#completed = null;
    this.#emit({ enabled: false, phase: 'paused', original: '', translation: '', warnings: [], message });
  }
  async enable(target) {
    this.stop('正在准备本地英译中引擎…');
    const session = this.#session = { task: this.#life.begin(), target: structuredClone(target), ready: false };
    this.#emit({ enabled: true, phase: 'enabling' });
    try {
      await this.translator.enable({ signal: session.task.signal, onProgress: progress => {
        if (session.task.current()) this.#emit({ message: `英译中语言包准备进度 ${progress}%…` });
      } });
      if (!session.task.current()) return;
      session.ready = true;
      this.#emit({ phase: 'waiting', message: '自动阅读已开启，等待最新助手回复稳定…' });
      await this.poll();
    } catch (error) {
      if (session.task.current()) this.#fail(error.message);
    }
  }
  #fail(message) {
    this.stop(message);
    this.#emit({ phase: 'error' });
  }
  async poll() {
    const session = this.#session;
    if (!session?.ready || !session.task.current() || this.#reading) return;
    const reading = this.#reading = {};
    const timerController = new AbortController();
    const signal = AbortSignal.any([session.task.signal, timerController.signal]);
    const timer = setTimeout(() => timerController.abort(), this.readTimeout);
    try {
      const result = await abortable(this.read(session.target), signal);
      if (!session.task.current()) return;
      if (!result?.ok) { this.#fail(result?.message || '无法读取当前回复，请回 Claude 再点扩展图标，然后重试。'); return; }
      const reply = result.reply;
      if (!reply) {
        this.#work.cancel(); this.#observation = this.#inflight = this.#completed = null;
        this.#emit({ phase: 'waiting', original: '', translation: '', warnings: [], message: result.message || '尚未识别到最新助手回复，正在等待。' });
        return;
      }
      if (typeof reply.text !== 'string' || typeof reply.stableText !== 'string' || [...reply.text].length > 60000 || [...reply.stableText].length > 60000) {
        this.#fail('回复格式不可用或超过 60,000 字，未截断；请查看网页英文原文。'); return;
      }
      const candidate = reply.streaming ? reply.stableText : reply.text;
      const changed = !this.#observation || this.#observation.id !== reply.id || this.#observation.candidate !== candidate;
      if (changed) {
        const keepPrefix = this.#observation?.id === reply.id && this.#completed && candidate.startsWith(this.#completed.source);
        this.#work.cancel(); this.#inflight = null;
        if (!keepPrefix) this.#completed = null;
        this.#observation = { id: reply.id, candidate, since: this.clock() };
        this.#emit({ translation: keepPrefix ? this.state.translation : '', warnings: [], phase: 'waiting' });
      }
      this.#emit({ original: reply.text });
      if (!candidate.trim()) { this.#emit({ message: '回复正在生成，等待可确认的稳定段落。' }); return; }
      if (this.#completed?.id === reply.id && this.#completed.source === candidate) {
        this.#emit({ phase: 'reading', message: reply.streaming ? '已译稳定片段；回复仍在生成，后续内容会自动更新。' : '已翻译当前稳定内容；后续新回复会自动更新。' }); return;
      }
      if (this.#inflight?.source === candidate && this.#inflight.id === reply.id) return;
      if (this.clock() - this.#observation.since < this.settleMs) {
        this.#emit({ message: '检测到回复变化，等待内容稳定后自动翻译…' }); return;
      }
      const task = this.#work.begin();
      const work = this.#inflight = { id: reply.id, source: candidate, task };
      this.#emit({ phase: 'translating', message: this.state.translation ? '正在更新稳定内容；下方暂为此前已完成片段。' : '正在本地翻译当前稳定内容…' });
      // Do not block observation while the model is busy: changed snapshots cancel this task.
      this.translationPromise = (async () => {
        try {
          const result = await this.translator.translate(candidate, AbortSignal.any([session.task.signal, task.signal]));
          if (!session.task.current() || !task.current()) return;
          this.#completed = { id: work.id, source: work.source };
          this.#emit({ phase: 'reading', translation: result.text, warnings: result.warnings,
            message: reply.streaming ? '已译稳定片段；回复仍在生成，后续内容会自动更新。' : '已翻译当前稳定内容；后续新回复会自动更新。' });
        } catch (error) {
          if (session.task.current() && task.current()) this.#fail(error.message || '本地回复翻译失败，请重试。');
        } finally { if (this.#inflight === work) this.#inflight = null; }
      })();
    } catch (error) {
      if (session.task.current()) this.#fail(timerController.signal.aborted ? '读取页面超时，自动阅读已暂停，请重试。' : '读取页面失败，自动阅读已暂停，请重试。');
    } finally { clearTimeout(timer); if (this.#reading === reading) this.#reading = null; }
  }
}
