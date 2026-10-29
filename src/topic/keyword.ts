/**
 * 关键词召回与排序（纯函数，无 IO）。
 *
 * 首版检索只覆盖**摘要层**：话题标题、摘要正文、摘要关键词。原文全文检索是明确的
 * 非目标，所以这里不需要倒排索引——对「当前部署已知话题」做有界扫描即可，规模超出
 * 后再换物理索引，接口不变。
 *
 * 分词要点（中文必须有测试）：
 * - 拉丁文按空白/标点切词，大小写与全半角归一。
 * - 中文没有空格，用 **二元组（bigram）** 召回：`跨机器人` → `跨机`/`机器`/`器人`。
 *   单字查询（1 个字）保留单字，避免 bigram 化之后一个 token 都不剩。
 * - 多词查询是 **AND**：所有 token 都必须在话题里出现，否则不算命中——否则「跨 bot
 *   owner」会把只含 `owner` 的无关话题全带出来。
 */

export interface KeywordSummaryLike {
  id: string;
  text: string;
  keywords: readonly string[];
}

export interface KeywordTopicLike {
  title: string;
  summaries: readonly KeywordSummaryLike[];
}

export interface KeywordToken {
  text: string;
  /** 拉丁/数字 vs 中文二元组：两者的命中权重与比较方式不同。 */
  kind: 'latin' | 'cjk';
}

export interface KeywordSummaryMatch {
  summaryId: string;
  text: string;
  score: number;
}

export interface KeywordTopicMatch {
  score: number;
  matches: KeywordSummaryMatch[];
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const TOKEN_SPLIT_RE = /[\s\u3000-\u303f\uff00-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65!-/:-@[-`{-~]+/;

/** 归一化：NFKC（全角→半角）、小写、压缩空白。 */
export function normalizeKeywordText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 查询分词。返回的 token 已去重、保序。 */
export function tokenizeQuery(query: unknown): KeywordToken[] {
  const normalized = normalizeKeywordText(query);
  if (!normalized) return [];
  const tokens: KeywordToken[] = [];
  const seen = new Set<string>();
  const push = (text: string, kind: KeywordToken['kind']): void => {
    if (!text || seen.has(text)) return;
    seen.add(text);
    tokens.push({ text, kind });
  };

  for (const chunk of normalized.split(TOKEN_SPLIT_RE)) {
    if (!chunk) continue;
    if (!CJK_RE.test(chunk)) {
      push(chunk, 'latin');
      continue;
    }
    // 中英混排（如 `跨bot`）：先把非中日韩片段单独切成拉丁 token，再对汉字串做 bigram。
    const segments = chunk.split(/([^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)/).filter(Boolean);
    for (const segment of segments) {
      if (!CJK_RE.test(segment)) {
        push(segment, 'latin');
        continue;
      }
      if (segment.length === 1) {
        push(segment, 'cjk');
        continue;
      }
      for (let index = 0; index + 1 < segment.length; index += 1) {
        push(segment.slice(index, index + 2), 'cjk');
      }
    }
  }
  return tokens;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    count += 1;
    from = at + needle.length;
    if (count >= 3) break; // 单条字段里重复出现不再加分（防堆词刷分）
  }
  return count;
}

function keywordHitRank(token: KeywordToken, field: string): number {
  // 精确关键词命中权重最高；拉丁词还要求「整词」边界，避免 `bot` 命中 `bottle`。
  const values = field.split(/[,，;；]/).map(part => normalizeKeywordText(part)).filter(Boolean);
  if (token.kind === 'latin') {
    return values.some(value => value === token.text) ? 3 : 0;
  }
  return values.some(value => value === token.text || value.includes(token.text)) ? 3 : 0;
}

/**
 * 单个话题的关键词匹配。返回 null 表示**不命中**（AND 语义下缺任一 token）。
 * 分数只用于排序，不与向量分数直接相加（见 vector.ts 的 RRF）。
 */
export function matchTopicByKeyword(
  topic: KeywordTopicLike,
  tokens: readonly KeywordToken[],
): KeywordTopicMatch | null {
  if (tokens.length === 0) return null;

  const title = normalizeKeywordText(topic.title);
  const summaryTexts = topic.summaries.map(summary => ({
    summary,
    text: normalizeKeywordText(summary.text),
    keywords: (summary.keywords ?? []).map(normalizeKeywordText).join('，'),
  }));

  const matchedTokenTexts = new Set<string>();
  const perSummary = new Map<string, number>();

  for (const token of tokens) {
    let anyMatch = false;
    if (countOccurrences(title, token.text) > 0) {
      anyMatch = true;
    }
    for (const entry of summaryTexts) {
      let score = 0;
      if (keywordHitRank(token, entry.keywords) > 0) score += 3;
      else if (countOccurrences(entry.keywords, token.text) > 0) score += 2;
      if (countOccurrences(entry.text, token.text) > 0) {
        score += token.kind === 'cjk' ? 1 : 2;
      }
      if (score > 0) {
        anyMatch = true;
        perSummary.set(entry.summary.id, (perSummary.get(entry.summary.id) ?? 0) + score);
      }
    }
    if (anyMatch) matchedTokenTexts.add(token.text);
  }

  if (matchedTokenTexts.size !== tokens.length) return null;

  const matches: KeywordSummaryMatch[] = summaryTexts
    .map(entry => ({
      summaryId: entry.summary.id,
      text: entry.summary.text,
      score: perSummary.get(entry.summary.id) ?? 0,
    }))
    .filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score || a.summaryId.localeCompare(b.summaryId));

  // 只有标题命中、没有任何摘要命中时也返回结果：话题确实相关，但要看标题级匹配。
  const titleScore = tokens.reduce(
    (total, token) => total + (countOccurrences(title, token.text) > 0 ? 2 : 0),
    0,
  );
  return { score: titleScore + matches.reduce((total, match) => total + match.score, 0), matches };
}
