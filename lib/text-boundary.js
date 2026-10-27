// A deliberately conservative character boundary, not language or account-risk detection.
const boundary = /\p{Script=Han}|[\u3000-\u303f\ufe10-\ufe19\ufe30-\ufe4f\uff01-\uff60\uffe0-\uffe6]/u;
export const containsChinese = text => boundary.test(text);
export function chineseLocations(text, limit = 5) {
  let line = 1, column = 1, count = 0;
  const locations = [];
  for (const character of text) {
    if (boundary.test(character)) {
      count++;
      if (locations.length < limit) locations.push({ character, line, column });
    }
    if (character === '\n') { line++; column = 1; } else column++;
  }
  return { count, locations };
}
export function boundaryMessage(text) {
  const { count, locations } = chineseLocations(text);
  return count ? `结果含 ${count} 个汉字或中文全角字符，已禁止填入。${locations.map(p => `第 ${p.line} 行第 ${p.column} 列“${p.character}”`).join('；')}。代码、注释、路径和链接也会检查，请自行处理，插件不会静默删改。` : '';
}
export function englishPrompt(text) {
  const error = boundaryMessage(text);
  if (error) throw new Error(error);
  return text;
}
