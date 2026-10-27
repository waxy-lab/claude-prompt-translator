import { splitProtected, translateProtected, codePoints } from './protected-text.js';
import { replyBlocks } from './reply-format.js';

function validSlots(output, slots) {
  if (typeof output !== 'string' || !output.trim()) return false;
  let previous = -1;
  for (const { marker } of slots) {
    const at = output.indexOf(marker);
    if (at < previous || at < 0 || output.indexOf(marker, at + marker.length) >= 0) return false;
    previous = at;
  }
  const prefix = slots[0]?.prefix;
  return !prefix || output.toUpperCase().split(prefix.toUpperCase()).length - 1 === slots.length;
}

// Paragraph context without sending protected code/URLs to the local model.
// A changed/lost/reordered/duplicated marker is rejected, never guessed or silently removed.
export async function translateReplyText(text, translate, check = () => {}) {
  if (!text.trim()) throw Error('没有可翻译的回复。');
  if (codePoints(text) > 60000) throw Error('回复超过 60,000 字，未截断。');
  const result = [], warnings = new Set();
  for (const block of replyBlocks(text)) {
    check();
    if (block.kind === 'code') { result.push(block.raw); continue; }
    const { spans, warnings: scanWarnings } = splitProtected(block.text, { protectTechnical: true });
    for (const warning of scanWarnings) warnings.add(warning);
    if (!spans.some(span => span.kind === 'text' && /[A-Za-z]/.test(span.text))) {
      result.push((block.prefix || '') + block.text); continue;
    }
    let prefix = 'cpt_keep_';
    while (block.text.toLowerCase().includes(prefix)) { prefix += 'x'; if (prefix.length > 64) throw Error('保护标记冲突过多，请对照英文原文阅读。'); }
    const slots = [];
    const payload = spans.map(span => {
      if (span.kind === 'text') return span.text;
      const marker = `${prefix}${String(slots.length).padStart(5, '0')}`; slots.push({ prefix, marker, text: span.text }); return marker;
    }).join('').replace(/\s+/g, ' ').trim();
    let translated;
    const accept = raw => validSlots(raw, slots);
    const raw = await translate(payload, { validate: accept, protectedTemplate: slots.length > 0 });
    check();
    if (accept(raw)) {
      translated = raw.replace(/\s+/g, ' ').trim();
      for (const slot of slots) translated = translated.replace(slot.marker, () => slot.text);
    } else {
      if (!slots.length) throw Error('本地引擎没有返回完整段落。');
      warnings.add('有段落的保护标记未通过校验，已退回安全分段翻译；请重点核对该段措辞。');
      const fallback = await translateProtected(block.text, body => translate(body), check,
        { shouldTranslate: value => /[A-Za-z]/.test(value), maxLength: 60000, protectTechnical: true });
      translated = fallback.text;
      for (const warning of fallback.warnings) warnings.add(warning);
    }
    result.push((block.prefix || '') + translated);
  }
  check(); return { text: result.join('\n\n'), warnings: [...warnings] };
}
