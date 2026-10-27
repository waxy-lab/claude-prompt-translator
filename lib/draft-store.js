export class DraftStore {
  #queue = Promise.resolve();
  constructor(storage) { this.storage = storage; }
  #enqueue(action) {
    const next = this.#queue.then(action);
    this.#queue = next.catch(() => {});
    return next;
  }
  read(key) { return this.#enqueue(async () => (await this.storage.get(key))[key] ?? null); }
  save(key, value) { const copy = structuredClone(value); return this.#enqueue(() => this.storage.set({ [key]: copy })); }
  clear(key) { return this.#enqueue(() => this.storage.remove(key)); }
  clearTab(tabId) {
    return this.#enqueue(async () => {
      const all = await this.storage.get(null);
      const keys = Object.keys(all).filter(key => key.startsWith(`draft:${tabId}:`));
      if (keys.length) await this.storage.remove(keys);
    });
  }
}
