export function isClaudeUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'claude.ai' && !u.port && !u.username && !u.password;
  } catch { return false; }
}

export function sameTarget(a, b) {
  return !!a && !!b && ['tabId', 'windowId', 'href', 'documentId', 'nonce', 'revision']
    .every(k => a[k] === b[k]);
}

export function draftKey(target) {
  // Reloading the same route restores its draft; document identity is separately checked on write.
  return `draft:${target.tabId}:${target.href}`;
}

// Self-contained: executed in the top frame's isolated world. Reads metadata only.
export function captureIdentity() {
  if (location.origin !== 'https://claude.ai' || document.visibilityState !== 'visible' || !globalThis.navigation?.addEventListener) return null;
  const key = '__claudeEnglishAssistantIdentityV1';
  if (!globalThis[key]) {
    const identity = { nonce: crypto.randomUUID(), revision: 0 };
    globalThis[key] = identity;
    const bump = () => { identity.revision++; };
    // The Navigation API sees SPA navigations, including a route change followed by a return.
    globalThis.navigation?.addEventListener('navigate', bump);
    addEventListener('popstate', bump);
    addEventListener('hashchange', bump);
    addEventListener('pagehide', bump);
  }
  return { href: location.href, ...globalThis[key] };
}
