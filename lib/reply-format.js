// Deliberately small text-view format: headings, list items, paragraphs, fenced code.
export function replyBlocks(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const blocks = []; let prose = [];
  const flush = () => { const value = prose.join('').trim(); if (value) blocks.push({ kind: 'paragraph', text: value }); prose = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r?\n$/, '');
    const open = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
    if (open) {
      flush(); const raw = [lines[i]], body = []; let closed = false;
      const closing = new RegExp(`^ {0,3}${open[1][0]}{${open[1].length},}[ \\t]*$`);
      while (++i < lines.length) {
        raw.push(lines[i]);
        if (closing.test(lines[i].replace(/\r?\n$/, ''))) { closed = true; break; }
        body.push(lines[i]);
      }
      if (!closed) throw Error('回复代码围栏未闭合，等待内容完整后再处理。');
      const code = body.join('').replace(/\n$/, ''); // remove only the serializer's separator
      blocks.push({ kind: 'code', text: code, language: open[2].trim(), raw: raw.join('').trimEnd() });
    } else if (!line.trim()) flush();
    else {
      const heading = /^(#{1,6}) (.*)$/.exec(line), item = /^([-+*]|\d+[.)]) (.*)$/.exec(line);
      if (heading || item) {
        flush(); blocks.push({ kind: heading ? 'heading' : 'list-item', level: heading?.[1].length, prefix: (heading?.[1] || item[1]) + ' ', text: heading?.[2] ?? item[2] });
      } else prose.push(lines[i]);
    }
  }
  flush(); return blocks;
}

export function renderReply(container, text, doc = document) {
  const fragment = doc.createDocumentFragment();
  for (const block of replyBlocks(text)) {
    if (block.kind === 'code') {
      const wrap = doc.createElement('section'); wrap.className = 'reply-code';
      if (block.language) { const label = doc.createElement('div'); label.className = 'code-language'; label.textContent = block.language; wrap.append(label); }
      const pre = doc.createElement('pre'), code = doc.createElement('code');
      code.textContent = block.text; pre.append(code); wrap.append(pre); fragment.append(wrap);
    } else {
      const node = doc.createElement(block.kind === 'heading' ? 'h3' : block.kind === 'list-item' ? 'div' : 'p');
      node.className = block.kind === 'list-item' ? 'reply-item' : 'reply-paragraph';
      // Inline code only; every other character remains a text node, never HTML.
      const source = (block.kind === 'list-item' ? '• ' : '') + block.text;
      // Use a small exact-run scanner instead of interpreting Markdown or HTML.
      let at = 0;
      while (at < source.length) {
        const start = source.indexOf('`', at);
        if (start < 0) { node.append(doc.createTextNode(source.slice(at))); break; }
        node.append(doc.createTextNode(source.slice(at, start)));
        const marker = /^`+/.exec(source.slice(start))[0]; let end = start + marker.length, found = -1;
        while ((end = source.indexOf('`', end)) >= 0) { const run = /^`+/.exec(source.slice(end))[0]; if (run.length === marker.length) { found = end; break; } end += run.length; }
        if (found < 0) { node.append(doc.createTextNode(source.slice(start))); break; }
        const code = doc.createElement('code'); code.textContent = source.slice(start + marker.length, found); node.append(code); at = found + marker.length;
      }
      fragment.append(node);
    }
  }
  container.replaceChildren(fragment);
}
