// Self-contained function for chrome.scripting.executeScript, ISOLATED world only.
// Receives English only. Existing webpage text never leaves this function.
export async function claudeAdapter(request) {
  const failure = (code, message) => ({ ok: false, code, message });
  const identity = () => globalThis.__claudeEnglishAssistantIdentityV1;
  const matches = () => {
    const id = identity(), expected = request.expected;
    return location.origin === 'https://claude.ai' && location.href === expected.href &&
      id?.nonce === expected.nonce && id?.revision === expected.revision && document.visibilityState === 'visible';
  };
  if (!matches()) return failure('TARGET_CHANGED', '目标页面或会话已变化，请回到对应 Claude 页面重试。');
  const visible = el => {
    if (!el.isConnected || el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && el.getClientRects().length > 0;
  };
  // Known editor markers identify the composer without depending on incidental
  // main/form wrappers. Generic textbox roles still require a form/fieldset.
  // Never fall back to an arbitrary contenteditable or the last focused element.
  const editorSelector = [
    '.ProseMirror[contenteditable="true"]',
    '[data-lexical-editor="true"][contenteditable="true"]',
    '[data-testid="chat-input"][contenteditable="true"]',
    '#chat-input[contenteditable="true"]',
    'textarea[data-testid="chat-input"]', 'textarea#chat-input',
    'main form [contenteditable="true"][role="textbox"]',
    'main fieldset [contenteditable="true"][role="textbox"]'
  ].join(', ');
  const excluded = 'dialog, [role="dialog"], aside, [role="search"], [data-testid="artifact"], [data-testid="artifact-panel"], [data-testid="artifacts-panel"], [data-testid="document-editor"]';
  const candidates = () => [...document.querySelectorAll(editorSelector)]
    .filter(el => visible(el) && !el.closest(excluded));
  const editable = el => !el.disabled && !el.readOnly && el.getAttribute('aria-disabled') !== 'true' &&
    (el.tagName === 'TEXTAREA' || el.isContentEditable) && !el.querySelector('[contenteditable="false"], img, video, iframe');
  const busy = el => {
    const scope = el.closest('form, fieldset');
    return scope?.matches?.(':disabled') || scope?.getAttribute('aria-busy') === 'true' || [...document.querySelectorAll(
      '[data-testid="stop-button"], button[aria-label="Stop response"], button[aria-label="Stop generating"], button[aria-label="停止响应"], button[aria-label="停止生成"]'
    )].some(visible);
  };
  const read = el => el.tagName === 'TEXTAREA' ? el.value :
    (el.textContent === '' ? '' : el.innerText.replace(/\r\n/g, '\n'));
  const key = '__claudeEnglishAssistantWriteV1';
  let state = globalThis[key];
  if (!state) state = globalThis[key] = { pending: null };
  const release = () => {
    const p = state.pending;
    if (p) { p.observer.disconnect(); p.el.removeEventListener('input', p.changed); p.el.removeEventListener('compositionstart', p.changed); clearTimeout(p.timer); }
    state.pending = null;
  };
  if (request.mode === 'cancel') { release(); return { ok: true }; }
  const editors = candidates();
  if (editors.length !== 1) {
    if (editors.length > 1) return failure('EDITOR_AMBIGUOUS', `识别到 ${editors.length} 个可用编辑器，为避免填错已停止。请关闭其他编辑区后重试，或复制英文。`);
    const visibleCount = [...document.querySelectorAll('[contenteditable="true"], textarea')].filter(visible).length;
    return failure('EDITOR_AMBIGUOUS', `当前输入框结构尚未识别（可见编辑区 ${visibleCount} 个，匹配 0 个）。请复制英文手动粘贴；排查时可提供这条提示。`);
  }
  const el = editors[0];
  if (!editable(el) || busy(el)) return failure('EDITOR_BUSY', '输入框只读、包含非文本内容或 Claude 正在生成，请稍后重试。');
  if (request.mode === 'prepare') {
    release();
    const p = { el, original: read(el), token: crypto.randomUUID(), dirty: false, created: Date.now() };
    p.changed = () => { p.dirty = true; };
    p.observer = new MutationObserver(p.changed);
    p.observer.observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
    el.addEventListener('input', p.changed);
    el.addEventListener('compositionstart', p.changed);
    p.timer = setTimeout(release, 60000);
    state.pending = p;
    return { ok: true, token: p.token, nonempty: p.original.length > 0 };
  }
  const p = state.pending;
  if (request.mode !== 'commit' || !p || p.token !== request.token || Date.now() - p.created > 60000) {
    return failure('EXPIRED', '填入确认已过期，请重新点击“填入 Claude”。');
  }
  const unchanged = () => matches() && p.el === el && p.el.isConnected && !p.dirty &&
    p.observer.takeRecords().length === 0 && read(el) === p.original && editable(el) && !busy(el) &&
    candidates().length === 1 && candidates()[0] === el;
  if (!unchanged() || (p.original.length > 0 && request.replace !== true)) {
    release(); return failure('DRAFT_CHANGED', '网页草稿或输入框已变化，已取消填入，请检查后重试。');
  }
  const text = request.text;
  if (typeof text !== 'string' || !text.trim() || [...text].length > 120000 || text.includes('\r')) {
    release(); return failure('INVALID_TEXT', '英文结果为空、过长或格式不可用，请检查后重试。');
  }
  // Focus handlers may change the draft; recheck AFTER focus, before selecting/writing.
  el.focus();
  if (!unchanged()) { release(); return failure('DRAFT_CHANGED', '聚焦输入框时页面内容发生变化，已停止填入。'); }
  release();
  let accepted = true;
  try {
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      // Native plain-text editing updates common rich-text editor state. Deprecated, isolated here.
      accepted = document.execCommand('insertText', false, text);
    }
    await new Promise(resolve => setTimeout(resolve, 80));
    if (!accepted || !matches() || !el.isConnected || read(el) !== text) {
      return failure('UNCONFIRMED', '无法确认填入成功，请检查网页输入框。不会自动重试或回滚。');
    }
    return { ok: true, inserted: true };
  } catch {
    return failure('UNCONFIRMED', '无法确认填入成功，请检查网页输入框。不会自动重试或回滚。');
  }
}
