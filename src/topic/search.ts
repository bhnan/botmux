/**
 * 检索服务：授权范围内召回 → 融合 → 按话题去重 → 返回可达结果。
 *
 * 三条不可让步的顺序约束（spec §6.1）：
 * 1. **先按调用者授权缩小候选**，再做打分。绝不能「全库 Top-K 之后过滤」——那既会泄露
 *    不可见话题的存在性（分数/条数变化），也会把合法结果挤掉。
 * 2. 关键词分与向量分**不相加**，只用 RRF 按名次融合（量纲不同）。
 * 3. 每个话题只返回一条，带命中的摘要片段与来源消息 id；覆盖不完整时明确 `partial`，
 *    不把「还没索引」伪装成「不存在」。
 */

import type { Topic, TopicSummary } from '../types.js';
import { parseTopicKey } from './identity.js';
import { matchTopicByKeyword, normalizeKeywordText, tokenizeQuery, type KeywordTopicMatch } from './keyword.js';
import type { TopicStore } from './store.js';
import { cosineSimilarity, reciprocalRankFusion, type RankedKey } from './vector.js';

export type TopicSearchMode = 'keyword' | 'hybrid' | 'auto';

export type TopicSearchErrorCode =
  | 'invalid_query'
  | 'invalid_limit'
  | 'invalid_filter'
  | 'invalid_cursor'
  | 'forbidden'
  | 'budget_exceeded';

export class TopicSearchError extends Error {
  readonly code: TopicSearchErrorCode;

  constructor(code: TopicSearchErrorCode, message: string) {
    super(message);
    this.name = 'TopicSearchError';
    this.code = code;
  }
}

export interface TopicSearchFilters {
  chatIds?: string[];
  sourceFrom?: string | null;
  sourceTo?: string | null;
}

export interface TopicSearchQuery {
  query: string;
  filters?: TopicSearchFilters;
  mode?: TopicSearchMode;
  limit?: number;
  cursor?: string | null;
}

export interface TopicSearchCaller {
  /** 调用者被授权读取的群。空数组 = 什么都读不到（不是「全部」）。 */
  allowedChatIds: readonly string[];
}

export interface TopicSearchMatch {
  summaryId: string;
  text: string;
  sourceMessageIds: string[];
}

export interface TopicSearchItem {
  topicKey: string;
  title: string;
  url?: string;
  matches: TopicSearchMatch[];
  updatedAt: string;
  sourceThroughAt?: string;
  /** 结果对调用者的可用性说明（例如该话题向量尚未回填）。 */
  degraded?: string[];
}

export interface TopicSearchResponse {
  items: TopicSearchItem[];
  effectiveMode: 'keyword' | 'hybrid';
  degradedReasons: string[];
  coverage: { state: 'complete' | 'partial'; unindexedKnownTopics: number };
  nextCursor: string | null;
}

export interface QueryEmbedding {
  vector: number[];
  modelKey: string;
}

export interface TopicSearchDeps {
  store: TopicStore;
  now?: () => string;
  /** hybrid 模式下的查询向量；返回 null 表示向量通道不可用（降级关键词）。 */
  embedQuery?: (query: string) => Promise<QueryEmbedding | null>;
  /** 话题入口链接；缺省不返回 url（不伪造跳转）。 */
  topicUrl?: (topic: Topic) => string | undefined;
  /** 已知目录里的话题总数（用于 coverage）。缺省时无法断言完整。 */
  knownTopicCount?: () => number;
  /** 单次查询最多扫描多少话题（有界预算）。 */
  maxCandidateTopics?: number;
  /** 单次返回上限（含 limit 上限之外的硬顶）。 */
  hardLimit?: number;
}

export interface TopicSearchService {
  search(query: TopicSearchQuery, caller: TopicSearchCaller): Promise<TopicSearchResponse>;
}

const DEFAULT_MAX_CANDIDATES = 5_000;
const MAX_LIMIT = 50;
const MAX_QUERY_CHARS = 200;
const CURSOR_TTL_MS = 5 * 60_000;

function normalizeFilters(filters: TopicSearchFilters | undefined): {
  chatIds: string[];
  sourceFrom: string | null;
  sourceTo: string | null;
} {
  const chatIds = (filters?.chatIds ?? []).map(id => id.trim()).filter(Boolean);
  return {
    chatIds: [...new Set(chatIds)],
    sourceFrom: filters?.sourceFrom ?? null,
    sourceTo: filters?.sourceTo ?? null,
  };
}

function cursorSignature(input: {
  query: string;
  mode: string;
  chatIds: readonly string[];
  sourceFrom: string | null;
  sourceTo: string | null;
  indexVersion: string;
}): string {
  return JSON.stringify(input);
}

function encodeSearchCursor(payload: {
  signature: string;
  offset: number;
  exp: number;
}): string {
  return Buffer.from(JSON.stringify({ v: 1, ...payload }), 'utf8').toString('base64url');
}

function decodeSearchCursor(
  value: string,
): { signature: string; offset: number; exp: number } {
  if (!value) throw new TopicSearchError('invalid_cursor', 'cursor is empty');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      v?: unknown;
      signature?: unknown;
      offset?: unknown;
      exp?: unknown;
    };
    if (
      parsed.v !== 1 ||
      typeof parsed.signature !== 'string' ||
      typeof parsed.offset !== 'number' ||
      typeof parsed.exp !== 'number'
    ) {
      throw new Error('bad cursor shape');
    }
    return { signature: parsed.signature, offset: parsed.offset, exp: parsed.exp };
  } catch {
    throw new TopicSearchError('invalid_cursor', 'cursor is not decodable');
  }
}

/** 话题所属群：以 topicKey 编码里的 chatId 为准（列只是副本，key 才是身份）。 */
function chatIdOf(topic: Topic): string {
  return parseTopicKey(topic.topicKey)?.chatId ?? topic.chatId;
}

/** 源消息时间过滤：只用 `sourceThroughAt`（源侧推进的时间），不用摘要生成时间。 */
function passesSourceTimeFilter(topic: Topic, sourceFrom: string | null, sourceTo: string | null): boolean {
  if (!sourceFrom && !sourceTo) return true;
  const sourceThrough = topic.sourceThroughAt ? Date.parse(topic.sourceThroughAt) : NaN;
  if (Number.isNaN(sourceThrough)) {
    // 没有源时间就断言覆盖会造假：带时间过滤时排除它，并让 coverage 表达不确定性。
    return false;
  }
  if (sourceFrom && sourceThrough < Date.parse(sourceFrom)) return false;
  if (sourceTo && sourceThrough > Date.parse(sourceTo)) return false;
  return true;
}

function bestVectorMatches(
  topic: Topic,
  queryVector: number[],
  modelKey: string,
): Array<{ summary: TopicSummary; score: number }> {
  const scored: Array<{ summary: TopicSummary; score: number }> = [];
  for (const summary of topic.summaries) {
    const embedding = summary.embedding;
    if (!embedding || embedding.modelKey !== modelKey) continue;
    const score = cosineSimilarity(queryVector, embedding.vector);
    if (score === null) continue;
    scored.push({ summary, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 3);
}

export function createTopicSearchService(deps: TopicSearchDeps): TopicSearchService {
  const maxCandidates = deps.maxCandidateTopics ?? DEFAULT_MAX_CANDIDATES;
  const hardLimit = Math.min(deps.hardLimit ?? MAX_LIMIT, MAX_LIMIT);

  return {
    async search(query, caller) {
      const rawQuery = typeof query?.query === 'string' ? query.query.trim() : '';
      if (!rawQuery) throw new TopicSearchError('invalid_query', 'query must not be empty');
      if (rawQuery.length > MAX_QUERY_CHARS) {
        throw new TopicSearchError('invalid_query', 'query is too long');
      }
      const limit = query.limit === undefined ? 5 : Math.floor(query.limit);
      if (!Number.isFinite(limit) || limit < 1 || limit > hardLimit) {
        throw new TopicSearchError('invalid_limit', `limit must be within 1..${hardLimit}`);
      }
      const filters = normalizeFilters(query.filters);
      const allowed = new Set(caller.allowedChatIds.map(id => id.trim()).filter(Boolean));
      if (allowed.size === 0) {
        // 无授权 = 空结果，而不是「全库」；也不报错，避免被当成探测存在性的信号。
        return {
          items: [],
          effectiveMode: 'keyword',
          degradedReasons: ['no_authorized_scope'],
          coverage: { state: 'partial', unindexedKnownTopics: 0 },
          nextCursor: null,
        };
      }
      for (const chatId of filters.chatIds) {
        if (!allowed.has(chatId)) {
          throw new TopicSearchError('forbidden', 'requested chat scope is not authorized');
        }
      }
      if (filters.sourceFrom && Number.isNaN(Date.parse(filters.sourceFrom))) {
        throw new TopicSearchError('invalid_filter', 'sourceFrom must be an ISO-8601 timestamp');
      }
      if (filters.sourceTo && Number.isNaN(Date.parse(filters.sourceTo))) {
        throw new TopicSearchError('invalid_filter', 'sourceTo must be an ISO-8601 timestamp');
      }

      const requestedMode = query.mode ?? 'auto';
      const tokens = tokenizeQuery(rawQuery);
      if (tokens.length === 0) throw new TopicSearchError('invalid_query', 'query has no searchable token');

      // 候选 = 授权群内 + 群过滤内。先过滤，后面才打分。
      const allTopics = deps.store.listTopics({ limit: maxCandidates + 1 });
      const budgetExceeded = allTopics.length > maxCandidates;
      const candidates = allTopics
        .slice(0, maxCandidates)
        .filter(topic => allowed.has(chatIdOf(topic)))
        .filter(topic => filters.chatIds.length === 0 || filters.chatIds.includes(chatIdOf(topic)))
        .filter(topic => passesSourceTimeFilter(topic, filters.sourceFrom, filters.sourceTo));

      const degradedReasons: string[] = [];
      if (budgetExceeded) degradedReasons.push('candidate_budget_truncated');

      const indexVersion = JSON.stringify({
        topics: candidates.length,
        latestUpdatedAt: candidates.reduce((max, topic) => {
          const parsed = Date.parse(topic.updatedAt);
          return Number.isNaN(parsed) ? max : Math.max(max, parsed);
        }, 0),
        summaries: candidates.reduce((total, topic) => total + topic.summaries.length, 0),
      });
      const signature = cursorSignature({
        query: normalizeKeywordText(rawQuery),
        mode: requestedMode,
        chatIds: filters.chatIds,
        sourceFrom: filters.sourceFrom,
        sourceTo: filters.sourceTo,
        indexVersion,
      });
      let offset = 0;
      if (query.cursor) {
        const cursor = decodeSearchCursor(query.cursor);
        if (cursor.exp < Date.now()) throw new TopicSearchError('invalid_cursor', 'cursor expired');
        if (cursor.signature !== signature) {
          throw new TopicSearchError('invalid_cursor', 'cursor does not match this query');
        }
        offset = cursor.offset;
      }

      // 关键词通道
      const keywordScores = new Map<string, { topic: Topic; match: KeywordTopicMatch }>();
      for (const topic of candidates) {
        const match = matchTopicByKeyword(topic, tokens);
        if (!match) continue;
        keywordScores.set(topic.topicKey, { topic, match });
      }
      const keywordRanked: RankedKey[] = [...keywordScores.entries()]
        .map(([key, entry]) => ({ key, score: entry.match.score }))
        .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

      // 向量通道（可选）
      const wantVector = requestedMode === 'hybrid' || requestedMode === 'auto';
      let vectorRanked: RankedKey[] | null = null;
      let vectorMatchesByTopic = new Map<string, Array<{ summary: TopicSummary; score: number }>>();
      if (wantVector) {
        if (!deps.embedQuery) {
          degradedReasons.push('embedding_disabled');
        } else {
          let embedding: QueryEmbedding | null = null;
          try {
            embedding = await deps.embedQuery(rawQuery);
          } catch {
            degradedReasons.push('embedding_unavailable');
          }
          if (!embedding) {
            if (!degradedReasons.includes('embedding_unavailable')) degradedReasons.push('embedding_unavailable');
          } else {
            const scored: RankedKey[] = [];
            let topicsWithVectors = 0;
            for (const topic of candidates) {
              const matches = bestVectorMatches(topic, embedding.vector, embedding.modelKey);
              if (matches.length === 0) continue;
              topicsWithVectors += 1;
              vectorMatchesByTopic.set(topic.topicKey, matches);
              scored.push({ key: topic.topicKey, score: matches[0].score });
            }
            if (topicsWithVectors === 0) degradedReasons.push('embedding_not_backfilled');
            vectorRanked = scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
          }
        }
      }

      // 向量通道为空（无可用同空间向量）时不能宣称 hybrid —— 那是把关键词结果
      // 说成语义检索。降级必须体现在 effectiveMode + degradedReasons 上。
      const effectiveMode: 'keyword' | 'hybrid' =
        requestedMode === 'keyword' || !vectorRanked || vectorRanked.length === 0 ? 'keyword' : 'hybrid';

      let fused: Map<string, number>;
      if (effectiveMode === 'hybrid' && vectorRanked) {
        fused = reciprocalRankFusion([keywordRanked, vectorRanked]);
      } else {
        fused = new Map(keywordRanked.map(entry => [entry.key, entry.score]));
      }

      const ordered = [...fused.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([key]) => key);
      const page = ordered.slice(offset, offset + limit);
      const nextCursor =
        ordered.length > offset + limit
          ? encodeSearchCursor({ signature, offset: offset + limit, exp: Date.now() + CURSOR_TTL_MS })
          : null;

      const topicByKey = new Map(candidates.map(topic => [topic.topicKey, topic]));
      const items: TopicSearchItem[] = [];
      for (const key of page) {
        const topic = topicByKey.get(key);
        if (!topic) continue;
        const keywordMatch = keywordScores.get(key)?.match;
        const matches: TopicSearchMatch[] = [];
        if (keywordMatch) {
          for (const match of keywordMatch.matches.slice(0, 3)) {
            const summary = topic.summaries.find(item => item.id === match.summaryId);
            if (!summary) continue;
            matches.push({
              summaryId: summary.id,
              text: summary.text,
              sourceMessageIds: summary.sourceMessageIds,
            });
          }
        }
        if (matches.length === 0) {
          const vectorMatches = vectorMatchesByTopic.get(key) ?? [];
          for (const match of vectorMatches.slice(0, 3)) {
            matches.push({
              summaryId: match.summary.id,
              text: match.summary.text,
              sourceMessageIds: match.summary.sourceMessageIds,
            });
          }
        }
        const url = deps.topicUrl?.(topic);
        const pendingVectors = topic.summaries.filter(summary => !summary.embedding).length;
        items.push({
          topicKey: topic.topicKey,
          title: topic.title,
          ...(url ? { url } : {}),
          matches,
          updatedAt: topic.updatedAt,
          ...(topic.sourceThroughAt ? { sourceThroughAt: topic.sourceThroughAt } : {}),
          ...(pendingVectors > 0 ? { degraded: ['embedding_pending'] } : {}),
        });
      }

      const knownTotal = deps.knownTopicCount?.();
      let coverageState: 'complete' | 'partial' = 'partial';
      let unindexed = 0;
      if (knownTotal === undefined) {
        degradedReasons.push('coverage_unknown');
      } else {
        const stored = deps.store
          .listTopics({ limit: maxCandidates })
          .filter(topic => allowed.has(chatIdOf(topic))).length;
        unindexed = Math.max(0, knownTotal - stored);
        coverageState = unindexed === 0 ? 'complete' : 'partial';
      }

      return {
        items,
        effectiveMode,
        degradedReasons: [...new Set(degradedReasons)],
        coverage: { state: coverageState, unindexedKnownTopics: unindexed },
        nextCursor,
      };
    },
  };
}
