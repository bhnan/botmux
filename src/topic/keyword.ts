const STOP = new Set(['之前', '讨论', '话题', '一下', '关于', '请问', '我们', '的', '了', '在', '是', '和', 'the', 'a', 'of', 'about']);
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export function normalizeKeyword(text: string): string { return text.normalize('NFKC').toLowerCase().trim(); }
export function queryTerms(query: string): string[] {
  const normalized = normalizeKeyword(query);
  const terms = [...normalized.matchAll(/[a-z0-9_][a-z0-9_.:/-]*/g)].map(match => match[0]);
  for (const part of segmenter.segment(normalized)) if (part.isWordLike && /\p{Script=Han}/u.test(part.segment)) terms.push(part.segment);
  return [...new Set(terms.filter(term => !STOP.has(term)))].slice(0, 32);
}

export function keywordScore(query: string, title: string, text: string, keywords: readonly string[]): number {
  const terms = queryTerms(query), q = normalizeKeyword(query);
  const heading = normalizeKeyword(title), body = normalizeKeyword(text), keys = keywords.map(normalizeKeyword);
  if (!q) return 0;
  let score = (heading.includes(q) ? 12 : 0) + (body.includes(q) ? 8 : 0) + (keys.includes(q) ? 20 : 0), matched = 0;
  for (const term of terms) {
    const value = (heading.includes(term) ? 4 : 0) + (body.includes(term) ? 2 : 0) + (keys.includes(term) ? 7 : 0);
    if (value) matched++;
    score += value;
  }
  if (terms.length && matched === terms.length) score += 10;
  return score;
}
