// Self-contained and read-only. Never use the whole page as an answer fallback.
export function readLatestReply(expected) {
  const identity = globalThis.__claudeEnglishAssistantIdentityV1;
  if (location.origin !== 'https://claude.ai' || location.href !== expected.href || document.visibilityState !== 'visible' ||
      !identity || identity.nonce !== expected.nonce || identity.revision !== expected.revision) {
    return { ok: false, message: '页面已变化，已停止读取回复。' };
  }
  const excluded = 'aside,nav,dialog,footer,time,[role="navigation"],[role="dialog"],[role="search"],[role="toolbar"],[data-testid*="artifact" i],[data-testid*="thinking" i],[data-testid*="reasoning" i],[data-testid*="promo" i],[data-testid*="upsell" i],[data-testid*="banner" i],[data-testid*="message-actions" i],[data-testid*="feedback" i],[data-testid*="timestamp" i],[data-is-thinking="true"],[data-message-type="thinking"],.thinking-block,.sr-only,.screen-reader-only,.visually-hidden,[data-message-author-role="user"],[data-message-author-role="system"],[data-testid="user-message"],[contenteditable="true"]';
  function hidden(node) {
    if (node.closest('[hidden],[aria-hidden="true"]') || node.closest(excluded)) return true;
    // Accessibility-only summaries may use styles instead of the conventional class.
    for (let el = node; el && el !== document.body; el = el.parentElement) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return true;
      const rect = el.getBoundingClientRect();
      if ((s.position === 'absolute' || s.position === 'fixed') && rect.width <= 2 && rect.height <= 2 &&
          (s.overflow === 'hidden' || s.clipPath !== 'none' || s.clip !== 'auto')) return true;
    }
    return false;
  }
  const visible = node => !hidden(node) && node.getClientRects().length > 0;
  const outermost = nodes => nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)));
  const turns = outermost([...document.querySelectorAll('[data-message-author-role="assistant"],[data-testid="assistant-message"]')].filter(visible));
  const fallbacks = outermost([...document.querySelectorAll('.font-claude-response')].filter(visible));
  const latest = turns.at(-1) || fallbacks.at(-1);
  if (!latest) return { ok: true, reply: null, message: '尚未识别到助手回复。只读取明确标记，不会扫描整页；若已有回复，可能需要适配页面结构。' };
  let roots = [];
  // Prefer the actual rendered Markdown body over an assistant turn that also contains UI.
  for (const selector of ['[data-testid="assistant-message-content"],[data-testid="message-content"],[data-message-content]', '.standard-markdown,.markdown', '.font-claude-response']) {
    const found = [...latest.querySelectorAll(selector)].filter(visible);
    if (found.length) { roots = outermost(found); break; }
  }
  if (!roots.length) roots = [latest];

  let size = 0, nodes = 0;
  const take = text => { size += text.length; if (size > 180000) throw Error('too-large'); return text; };
  const fence = (text, min = 3) => '`'.repeat([...text.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length + 1), min));
  // Only merge boundary whitespace. Never normalize text inside a fenced code block.
  const join = parts => parts.filter(Boolean).reduce((a, b) =>
    a.endsWith('\n') && b.startsWith('\n') ? a.replace(/\n+$/, '') + '\n\n' + b.replace(/^\n+/, '') : a + b, '');
  const block = text => text.trim() ? `\n\n${text.trim()}\n\n` : '';
  function language(pre) {
    const code = pre.querySelector('code');
    const value = code?.getAttribute('data-language') || pre.getAttribute('data-language') ||
      [...(code?.classList || []), ...pre.classList].find(c => c.startsWith('language-'))?.slice(9) || '';
    if (/^[A-Za-z0-9_+#.-]{1,32}$/.test(value)) return value;
    const header = pre.previousElementSibling;
    const label = header?.textContent?.trim().match(/^(Python|JavaScript|TypeScript|Java|C\+\+|C#|Rust|Go|SQL|HTML|CSS|JSON|YAML|Bash|Shell|PowerShell)(?=\s|Copy|复制|$)/i)?.[1];
    return label || '';
  }
  function serialize(node, depth = 0) {
    if (++nodes > 10000 || depth > 64) throw Error('unsupported-depth');
    if (node.nodeType === 3) {
      // Mirror normal HTML whitespace; <pre>/<code> are handled atomically below.
      return take((node.textContent || '').replace(/[\t\r\n ]+/g, ' '));
    }
    if (node.nodeType !== 1 || node.matches('button,input,textarea,svg,script,style,[aria-hidden="true"],[hidden]') || hidden(node)) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'pre') {
      const code = take(node.querySelector('code')?.textContent ?? node.textContent ?? '');
      const marker = fence(code);
      // Always add ONE formatting separator, so the renderer can recover exact code bytes.
      return `\n\n${marker}${language(node)}\n${code}\n${marker}\n\n`;
    }
    if (tag === 'code') {
      const code = take(node.textContent || '');
      const marker = fence(code, 1), pad = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
      return `${marker}${pad}${code}${pad}${marker}`;
    }
    // A language/copy header adjacent to <pre> is editor chrome, not a paragraph.
    if (node.parentElement?.querySelector(':scope > pre') && !node.querySelector('pre') && !node.matches('p,h1,h2,h3,h4,h5,h6,li,ul,ol,blockquote,table,a') &&
        (node.querySelector('button') || /^(Python|JavaScript|TypeScript|Java|C\+\+|C#|Rust|Go|SQL|HTML|CSS|JSON|YAML|Bash|Shell|PowerShell)(?:\s|$)/i.test(node.textContent.trim()))) return '';
    // Small non-prose control rows (e.g. install/dismiss cards and action bars).
    if (node.querySelector(':scope > button') && !node.querySelector('p,h1,h2,h3,h4,h5,h6,pre,ul,ol,blockquote,table')) return '';
    if (tag === 'br') return '\n';
    const text = join([...node.childNodes].map(child => serialize(child, depth + 1)));
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      if (href) { if (/[<>\r\n]/.test(href)) throw Error('unsupported-link'); return `${text} <${take(href)}>`; }
    }
    if (/^h[1-6]$/.test(tag)) return block(`${'#'.repeat(Math.min(4, Number(tag[1]) + 1))} ${text.trim()}`);
    if (tag === 'li') return block(`- ${text.trim()}`);
    if (tag === 'td' || tag === 'th') return block(text);
    if (/^(p|blockquote|ul|ol|div|section|article|table|tr)$/.test(tag)) return block(text);
    return text;
  }
  try {
    const unsafe = roots.some(root => [...root.querySelectorAll('math,.katex,canvas,iframe')].some(visible));
    if (unsafe) throw Error('unsupported-nontext');
    const blocks = roots.flatMap(root => [...root.childNodes].map(node => serialize(node))).filter(text => text.trim());
    const text = join(blocks).trim();
    if (!text) return { ok: true, reply: null, message: '最新回复没有支持的正文文本，未读取整页。' };
    if ([...text].length > 60000) return { ok: false, message: '最新回复超过 60,000 字，未截断。请在英文原文中分段阅读。' };
    const streaming = latest.matches('[data-is-streaming="true"]') || !!latest.querySelector('[data-is-streaming="true"]') ||
      [...document.querySelectorAll('[data-testid="stop-button"],button[aria-label="Stop response"],button[aria-label="Stop generating"],button[aria-label="停止响应"],button[aria-label="停止生成"]')].some(visible);
    const stableText = streaming ? join(blocks.slice(0, -1)).trim() : text;
    const replyId = latest.getAttribute('data-message-id') || latest.getAttribute('data-testid') || 'assistant';
    return { ok: true, reply: { id: `${turns.length || fallbacks.length}:${replyId}`, text, stableText, streaming } };
  } catch { return { ok: false, message: '回复过大或结构暂不支持，未读取部分结果。英文原文仍保留在网页。' }; }
}
