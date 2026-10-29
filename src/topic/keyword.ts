/** Keyword recall over the authorized topic set (spec §6.1).
 *
 * First-version ranking is a bounded scan over title / summary text /
 * summary keywords. Tokenization is deliberately simple and deterministic:
 * latin/digit runs are matched whole; CJK runs become overlapping bigrams
 * (single characters pass through) so word-order variants like 撤销权限 ↔
 * 撤销了权限 still recall. Exact keyword/entity hits dominate the score —
 * that is where precision comes from; bigram text hits provide recall.
 */
import type { Topic, TopicSummary } from '../types.js';

const LATIN_RUN = /[A-Za-z0-9_.-]{2,}/g;
const CJK_RUN = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]+/g;

export interface QueryTokens {
  /** Latin/digit tokens (lowercased). */
  words: string[];
  /** CJK bigrams (or single chars for one-char runs). */
  bigrams: string[];
  /** Source runs for AND-matching across distinct query segments. */
  segments: Array<{ words: string[]; bigrams: string[] }>;
}

export function tokenizeQuery(query: string): QueryTokens {
  const normalized = query.toLowerCase();
  const words: string[] = [];
  const bigrams: string[] = [];
  const segments: QueryTokens['segments'] = [];
  // Segment on whitespace: every segment must contribute a hit somewhere in
  // the topic (multi-word AND semantics, spec §6.1 多词匹配).
  for (const rawSegment of normalized.split(/\s+/)) {
    if (!rawSegment) continue;
    const segment = { words: [] as string[], bigrams: [] as string[] };
    for (const word of rawSegment.match(LATIN_RUN) ?? []) {
      words.push(word);
      segment.words.push(word);
    }
    for (const run of rawSegment.match(CJK_RUN) ?? []) {
      if (run.length === 1) {
        bigrams.push(run);
        segment.bigrams.push(run);
        continue;
      }
      // 相邻 bigram 已覆盖首尾字符，无需额外单字
      for (let i = 0; i + 1 < run.length; i++) {
        bigrams.push(run.slice(i, i + 2));
        segment.bigrams.push(run.slice(i, i + 2));
      }
    }
    if (segment.words.length || segment.bigrams.length) segments.push(segment);
  }
  return { words, bigrams, segments };
}

export interface KeywordTopicScore {
  topicKey: string;
  score: number;
  /** Best-matching summaries (best first), for snippet display. */
  matchedSummaries: TopicSummary[];
}

const WEIGHT_EXACT_KEYWORD = 8;
const WEIGHT_TITLE = 4;
const WEIGHT_TEXT = 2;
const MAX_SNIPPET_SUMMARIES = 3;

function haystacks(topic: Topic): { title: string; texts: string[]; keywords: string[][] } {
  return {
    title: topic.title.toLowerCase(),
    texts: topic.summaries.map(s => s.text.toLowerCase()),
    keywords: topic.summaries.map(s => s.keywords.map(k => k.toLowerCase())),
  };
}

function segmentScore(segment: QueryTokens['segments'][number], topic: Topic, haystack: ReturnType<typeof haystacks>): number {
  let score = 0;
  // Latin words are AND'ed within a segment; CJK bigrams are recall-oriented
  // (any-bigram): 「权限撤销」 must recall 「撤销了权限」 even though the
  // crossing bigram 限撤 is absent in the target (spec §6.1 中文必须可检).
  // Precision is carried by exact-keyword hits, which dominate the score.
  for (const word of segment.words) {
    let hit = 0;
    if (haystack.title.includes(word)) hit += WEIGHT_TITLE;
    for (const keywords of haystack.keywords) {
      if (keywords.includes(word)) hit += WEIGHT_EXACT_KEYWORD;
    }
    for (const text of haystack.texts) {
      if (text.includes(word)) hit += WEIGHT_TEXT;
    }
    if (hit === 0) return 0;
    score += hit;
  }
  for (const bigram of segment.bigrams) {
    if (haystack.title.includes(bigram)) score += WEIGHT_TITLE;
    for (const keywords of haystack.keywords) {
      // Exact keyword containing the bigram still counts, less than a whole match.
      if (keywords.some(k => k.includes(bigram))) score += WEIGHT_EXACT_KEYWORD / 2;
    }
    for (const text of haystack.texts) {
      if (text.includes(bigram)) score += WEIGHT_TEXT;
    }
  }
  return score;
}

/** Score one topic against the query; 0 = no match. */
export function keywordScoreTopic(topic: Topic, tokens: QueryTokens): KeywordTopicScore | null {
  if (!tokens.segments.length) return null;
  const haystack = haystacks(topic);
  let total = 0;
  for (const segment of tokens.segments) {
    const score = segmentScore(segment, topic, haystack);
    if (score <= 0) return null;
    total += score;
  }
  // Snippets: summaries whose text/keywords hit any token, ranked by hit count.
  const matched = topic.summaries
    .map(summary => {
      const text = summary.text.toLowerCase();
      const keywords = summary.keywords.map(k => k.toLowerCase());
      let hits = 0;
      for (const word of tokens.words) {
        if (keywords.includes(word)) hits += WEIGHT_EXACT_KEYWORD;
        if (text.includes(word)) hits += WEIGHT_TEXT;
      }
      for (const bigram of tokens.bigrams) {
        if (keywords.some(k => k.includes(bigram))) hits += WEIGHT_EXACT_KEYWORD / 2;
        if (text.includes(bigram)) hits += WEIGHT_TEXT;
      }
      return { summary, hits };
    })
    .filter(entry => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, MAX_SNIPPET_SUMMARIES)
    .map(entry => entry.summary);
  return { topicKey: topic.topicKey, score: total, matchedSummaries: matched };
}

/** Rank authorized candidates by keyword score (desc, stable by topicKey). */
export function keywordRecall(topics: readonly Topic[], query: string): KeywordTopicScore[] {
  const tokens = tokenizeQuery(query);
  const scored: KeywordTopicScore[] = [];
  for (const topic of topics) {
    const result = keywordScoreTopic(topic, tokens);
    if (result && result.score > 0) scored.push(result);
  }
  return scored.sort((a, b) => b.score - a.score || a.topicKey.localeCompare(b.topicKey));
}
