export const MAX_SOURCE = 12000;
export const codePoints = text => [...text].length;
export const hasChinese = text => /\p{Script=Han}/u.test(text);

export function validateSource(text) {
  if (!text.trim()) throw new Error('请先输入中文或英文草稿。');
  if (codePoints(text) > MAX_SOURCE) throw new Error('草稿超过 12,000 字，请缩短后重试；内容没有被截断。');
}

// A deliberately limited Markdown scanner, not a complete Markdown parser.
// Protected spans are never sent to Translator; no model-dependent placeholders.
export function splitProtected(text, { protectTechnical = false } = {}) {
  const spans = [];
  const warnings = new Set();
  const add = (kind, value) => {
    if (!value) return;
    const prev = spans.at(-1);
    if (prev?.kind === kind) prev.text += value;
    else spans.push({ kind, text: value });
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const lineStart = i === 0 || text[i - 1] === '\n' || text[i - 1] === '\r';
    if (lineStart) {
      const fence = /^( {0,3})(`{3,}|~{3,})[^\r\n]*(?:\r\n|\n|\r|$)/.exec(rest);
      if (fence) {
        const run = fence[2];
        const closing = new RegExp(`^ {0,3}${run[0]}{${run.length},}[ \\t]*(?:\\r?\\n|\\r|$)`, 'm');
        const tail = rest.slice(fence[0].length);
        const end = closing.exec(tail);
        const length = end ? fence[0].length + end.index + end[0].length : rest.length;
        if (!end) warnings.add('未闭合的代码围栏已从起始处到文末原样保留。');
        add('protected', rest.slice(0, length)); i += length; continue;
      }
      const reference = /^ {0,3}\[[^\]\r\n]+\]:[^\r\n]*(?:\r\n|\n|\r|$)/.exec(rest);
      if (reference) { add('protected', reference[0]); i += reference[0].length; continue; }
      if (/^ {4}|^\t/.test(rest)) {
        throw new Error('检测到缩进代码块。请改用三个反引号或波浪线围栏后翻译，以保护代码。');
      }
      const marker = /^( {0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-+*][ \t]+|\d+[.)][ \t]+))/.exec(rest);
      if (marker) { add('protected', marker[0]); i += marker[0].length; continue; }
    }
    if (text[i] === '\\' && i + 1 < text.length) {
      add('protected', text.slice(i, i + 2)); i += 2; continue;
    }
    if (text[i] === '`') {
      const run = /^`+/.exec(rest)[0];
      let pos = i + run.length, end = -1;
      while (pos < text.length) {
        const next = text.indexOf('`', pos);
        if (next < 0) break;
        const other = /^`+/.exec(text.slice(next))[0];
        if (other.length === run.length) { end = next + run.length; break; }
        pos = next + other.length;
      }
      if (end < 0) throw new Error('检测到未闭合的行内代码反引号，请补齐后翻译。');
      add('protected', text.slice(i, end)); i = end; continue;
    }
    if (rest.startsWith('](')) {
      let p = i + 2, depth = 1;
      for (; p < text.length; p++) {
        if (text[p] === '\\') { p++; continue; }
        if (text[p] === '\n' || text[p] === '\r') break;
        if (text[p] === '(') depth++;
        else if (text[p] === ')') { depth--; if (depth === 0) break; }
      }
      if (depth !== 0) throw new Error('检测到未闭合或跨行的 Markdown 链接目标，请整理为单行链接。');
      add('protected', text.slice(i, p + 1)); i = p + 1; continue;
    }
    const url = /^(?:https?:\/\/|ftp:\/\/|mailto:|www\.)[^\s<>`"\[\]，。！？；：、]+/i.exec(rest);
    if (url) { add('protected', url[0]); i += url[0].length; continue; }
    const angle = /^<[^>\r\n]*>/.exec(rest);
    if (angle) { add('protected', angle[0]); i += angle[0].length; warnings.add('尖括号片段已原样保留；不支持完整 HTML/复杂 Markdown 解析。'); continue; }
    if (protectTechnical && (i === 0 || !/[\p{L}\p{N}_$]/u.test(text[i - 1]))) {
      const path = /^(?:[A-Za-z]:\\|\.{1,2}[\/]|\/(?:[A-Za-z0-9_.-]+\/)+)[^\s<>`"，。；]+/.exec(rest);
      const flag = /^--[A-Za-z][A-Za-z0-9_-]*(?:=[^\s<>`"]+)?/.exec(rest);
      const token = /^[A-Za-z_$][A-Za-z0-9_.$]*(?:\+\+|#|\(\))?/.exec(rest)?.[0].replace(/\.+$/, '');
      const identifier = token && (/[_.\d$]|[a-z][A-Z]|\+\+|#|\(\)/.test(token) || /^[A-Z]{2,}$/.test(token) || /^(?:Python|Java|Rust|Go|Bash|Shell|PowerShell|JavaScript|TypeScript)$/.test(token)) ? token : null;
      const protectedValue = path?.[0] || flag?.[0] || identifier;
      if (protectedValue) { add('protected', protectedValue); i += protectedValue.length; continue; }
    }
    add('text', text[i++]);
  }
  return { spans, warnings: [...warnings] };
}

export async function translateProtected(text, translate, check = () => {}, options = {}) {
  const { shouldTranslate = hasChinese, maxLength = MAX_SOURCE, protectTechnical = false } = options;
  if (!text.trim()) throw new Error('没有可翻译的文字。');
  if (codePoints(text) > maxLength) throw new Error(`内容超过 ${maxLength.toLocaleString('en-US')} 字，未截断或返回部分译文。`);
  const { spans, warnings } = splitProtected(text, { protectTechnical });
  const result = [];
  for (const span of spans) {
    check();
    if (span.kind === 'protected') { result.push(span.text); continue; }
    for (const line of span.text.split(/(\r\n|\n|\r)/)) {
      check();
      if (!shouldTranslate(line)) { result.push(line); continue; }
      const [, before, body, after] = /^(\s*)([\s\S]*?)(\s*)$/.exec(line);
      const translated = await translate(body);
      check();
      if (typeof translated !== 'string' || !translated.trim()) throw new Error('本地引擎没有返回完整结果，请重试。');
      if (/[\r\n]/.test(translated.trim())) throw new Error('本地引擎改变了单行结构，请检查原文后重试；未返回部分译文。');
      result.push(before + translated.trim() + after);
    }
  }
  return { text: result.join(''), warnings };
}
