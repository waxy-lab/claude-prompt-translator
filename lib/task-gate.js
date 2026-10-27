export class TaskGate {
  #serial = 0;
  #controller;
  cancel() { this.#serial++; this.#controller?.abort(); this.#controller = null; }
  begin() {
    this.cancel();
    const id = this.#serial;
    const controller = this.#controller = new AbortController();
    return { signal: controller.signal, current: () => id === this.#serial && !controller.signal.aborted };
  }
}

export function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new DOMException('已取消', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('已取消', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
