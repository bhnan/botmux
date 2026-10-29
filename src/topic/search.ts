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
  /** @deprecated 旧参数：等价于 `timeFilter.field=latestMessage`，会带降级标记。 */
  sourceFrom?: string | null;
  /** @deprecated 同 `sourceFrom`。 */
  sourceTo?: string | null;
}

export type TopicTimeField = 'created' | 'latestMessage';

/** 话题时间筛选：两种口径互斥，由调用方明确选择；不隐式组合。 */
export interface TopicTimeFilter {
  field: TopicTimeField;
  from?: string | null;
  to?: string | null;
}

export interface TopicSearchQuery {
  /** 关键词；纯日期筛选时可为空字符串。 */
  query: string;
  filters?: TopicSearchFilters;
  timeFilter?: TopicTimeFilter;
  mode?: TopicSearchMode;
  limit?: number;
  cursor?: string | null;
}

export interface TopicSearchCaller {
  /**
   * 调用者可见的群范围。**省略** = Dashboard 已认证，可读全部已保留历史话题；
   * 空数组 = 明确什么都读不到（不是「全部」）。更新范围（`allowedChatIds`）与
   * 历史检索范围不是一回事：群移出更新范围后，已保留的旧摘要仍应可检索。
   */
  visibleChatIds?: readonly string[];
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
  /** 成功摘要边界（保留原语义，不用于日期筛选）。 */
  sourceThroughAt?: string;
  /** 来源系统的话题创建时间；缺失 = 未知。 */
  topicCreatedAt?: string;
  /** 来源系统观察到的最新消息时间；缺失 = 未知。 */
  latestMessageAt?: string;
  timeMetadata: 'synced' | 'partial' | 'unknown';
  /** 结果对调用者的可用性说明（例如该话题向量尚未回填）。 */
  degraded?: string[];
}

export interface TopicSearchResponse {
  items: TopicSearchItem[];
  effectiveMode: 'keyword' | 'hybrid';
  degradedReasons: string[];
  coverage: {
    state: 'complete' | 'partial';
    unindexedKnownTopics: number;
    /** 所选时间口径下时间未知、无法参与筛选的可见话题数。 */
    unknownTimeTopics: number;
  };
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

function normalizeTimeFilter(
  raw: TopicTimeFilter | undefined,
  legacy: { sourceFrom: string | null; sourceTo: string | null },
): { filter: TopicTimeFilter | null; legacyMapped: boolean } {
  if (raw !== undefined) {
    if (legacy.sourceFrom || legacy.sourceTo) {
      throw new TopicSearchError(
        'invalid_filter',
        'timeFilter cannot be combined with legacy sourceFrom/sourceTo',
      );
    }
    if (raw.field !== 'created' && raw.field !== 'latestMessage') {
      throw new TopicSearchError('invalid_filter', 'timeFilter.field must be created/latestMessage');
    }
    const from = raw.from ?? null;
    const to = raw.to ?? null;
    for (const [key, value] of [['from', from], ['to', to]] as const) {
      if (value !== null && Number.isNaN(Date.parse(value))) {
        throw new TopicSearchError('invalid_filter', `timeFilter.${key} must be an ISO-8601 timestamp`);
      }
    }
    if (from && to && Date.parse(from) > Date.parse(to)) {
      throw new TopicSearchError('invalid_filter', 'timeFilter.from must not be after timeFilter.to');
    }
    if (!from && !to) return { filter: null, legacyMapped: false };
    return { filter: { field: raw.field, from, to }, legacyMapped: false };
  }
  if (legacy.sourceFrom || legacy.sourceTo) {
    // 旧参数没有「口径」概念；按最新消息时间解释并明确标记降级，避免静默改变语义。
    return {
      filter: { field: 'latestMessage', from: legacy.sourceFrom, to: legacy.sourceTo },
      legacyMapped: true,
    };
  }
  return { filter: null, legacyMapped: false };
}

function topicTimeOf(topic: Topic, field: TopicTimeField): string | undefined {
  return field === 'created' ? topic.topicCreatedAt : topic.latestMessageAt;
}

function passesTopicTimeFilter(topic: Topic, filter: TopicTimeFilter | null): boolean {
  if (!filter) return true;
  const value = topicTimeOf(topic, filter.field);
  if (!value) return false;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return false;
  if (filter.from && at < Date.parse(filter.from)) return false;
  if (filter.to && at > Date.parse(filter.to)) return false;
  return true;
}

function cursorSignature(input: {
  query: string;
  mode: string;
  chatIds: readonly string[];
  timeField: TopicTimeField | null;
  timeFrom: string | null;
  timeTo: string | null;
}): string {
  return JSON.stringify(input);
}

type SearchCursorPayload =
  | { signature: string; exp: number; kind: 'offset'; offset: number }
  | {
    signature: string;
    exp: number;
    kind: 'keyset';
    field: TopicTimeField;
    time: number;
    key: string;
  };

function encodeSearchCursor(payload: SearchCursorPayload): string {
  return Buffer.from(JSON.stringify({ v: 2, ...payload }), 'utf8').toString('base64url');
}

function decodeSearchCursor(value: string): SearchCursorPayload {
  if (!value) throw new TopicSearchError('invalid_cursor', 'cursor is empty');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.v !== 2 || typeof parsed.signature !== 'string' || typeof parsed.exp !== 'number') {
      throw new Error('bad cursor shape');
    }
    if (parsed.kind === 'offset' && typeof parsed.offset === 'number') {
      return { signature: parsed.signature, exp: parsed.exp, kind: 'offset', offset: parsed.offset };
    }
    if (
      parsed.kind === 'keyset'
      && (parsed.field === 'created' || parsed.field === 'latestMessage')
      && typeof parsed.time === 'number'
      && typeof parsed.key === 'string'
    ) {
      return {
        signature: parsed.signature,
        exp: parsed.exp,
        kind: 'keyset',
        field: parsed.field,
        time: parsed.time,
        key: parsed.key,
      };
    }
    throw new Error('bad cursor shape');
  } catch {
    throw new TopicSearchError('invalid_cursor', 'cursor is not decodable');
  }
}

/** 话题所属群：以 topicKey 编码里的 chatId 为准（列只是副本，key 才是身份）。 */
function chatIdOf(topic: Topic): string {
  return parseTopicKey(topic.topicKey)?.chatId ?? topic.chatId;
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
      if (rawQuery.length > MAX_QUERY_CHARS) {
        throw new TopicSearchError('invalid_query', 'query is too long');
      }
      const limit = query.limit === undefined ? 5 : Math.floor(query.limit);
      if (!Number.isFinite(limit) || limit < 1 || limit > hardLimit) {
        throw new TopicSearchError('invalid_limit', `limit must be within 1..${hardLimit}`);
      }
      const filters = normalizeFilters(query.filters);
      const visible = caller.visibleChatIds === undefined
        ? null
        : new Set(caller.visibleChatIds.map(id => id.trim()).filter(Boolean));
      if (visible && visible.size === 0) {
        // 明确无可见范围 = 空结果，而不是「全库」；也不报错，避免被当成探测存在性的信号。
        return {
          items: [],
          effectiveMode: 'keyword',
          degradedReasons: ['no_authorized_scope'],
          coverage: { state: 'partial', unindexedKnownTopics: 0, unknownTimeTopics: 0 },
          nextCursor: null,
        };
      }
      for (const chatId of filters.chatIds) {
        if (visible && !visible.has(chatId)) {
          throw new TopicSearchError('forbidden', 'requested chat scope is not authorized');
        }
      }
      if (filters.sourceFrom && Number.isNaN(Date.parse(filters.sourceFrom))) {
        throw new TopicSearchError('invalid_filter', 'sourceFrom must be an ISO-8601 timestamp');
      }
      if (filters.sourceTo && Number.isNaN(Date.parse(filters.sourceTo))) {
        throw new TopicSearchError('invalid_filter', 'sourceTo must be an ISO-8601 timestamp');
      }
      const timeFilter = normalizeTimeFilter(query.timeFilter, {
        sourceFrom: filters.sourceFrom,
        sourceTo: filters.sourceTo,
      });
      const effectiveTimeFilter = timeFilter.filter;
      const requestedMode = query.mode ?? 'auto';
      const tokens = tokenizeQuery(rawQuery);
      if (tokens.length === 0 && !effectiveTimeFilter) {
        throw new TopicSearchError('invalid_query', 'query must not be empty unless a time filter is provided');
      }

      // 候选 = 可见范围 + 群过滤 + 所选话题时间口径。**先过滤再计预算**：否则范围外
      // 或明显不匹配的记录会先占满 maxCandidates，把合法历史结果挤掉。
      const allTopics = deps.store.listTopics();
      const visibleTopics = visible
        ? allTopics.filter(topic => visible.has(chatIdOf(topic)))
        : allTopics;
      const chatScopedTopics = visibleTopics
        .filter(topic => filters.chatIds.length === 0 || filters.chatIds.includes(chatIdOf(topic)));
      const unknownTimeTopics = effectiveTimeFilter
        ? chatScopedTopics.filter(topic => {
          const value = topicTimeOf(topic, effectiveTimeFilter.field);
          // 缺失或无法解析都视为「时间不可用」：过滤与 coverage 用同一判定。
          return !value || Number.isNaN(Date.parse(value));
        }).length
        : 0;
      const scopedTopics = chatScopedTopics.filter(topic => passesTopicTimeFilter(topic, effectiveTimeFilter));
      const budgetExceeded = scopedTopics.length > maxCandidates;
      const candidates = scopedTopics.slice(0, maxCandidates);

      const degradedReasons: string[] = [];
      if (budgetExceeded) degradedReasons.push('candidate_budget_truncated');
      if (timeFilter.legacyMapped) degradedReasons.push('legacy_time_filter_mapped');
      if (unknownTimeTopics > 0) degradedReasons.push('time_metadata_unknown');

      const hasTokens = tokens.length > 0;
      const signature = cursorSignature({
        query: normalizeKeywordText(rawQuery),
        mode: requestedMode,
        chatIds: filters.chatIds,
        timeField: effectiveTimeFilter?.field ?? null,
        timeFrom: effectiveTimeFilter?.from ?? null,
        timeTo: effectiveTimeFilter?.to ?? null,
      });
      let offset = 0;
      let keyset: Extract<SearchCursorPayload, { kind: 'keyset' }> | null = null;
      if (query.cursor) {
        const cursor = decodeSearchCursor(query.cursor);
        if (cursor.exp < Date.now()) throw new TopicSearchError('invalid_cursor', 'cursor expired');
        if (cursor.signature !== signature) {
          throw new TopicSearchError('invalid_cursor', 'cursor does not match this query');
        }
        if (!hasTokens) {
          if (cursor.kind !== 'keyset' || cursor.field !== effectiveTimeFilter?.field) {
            throw new TopicSearchError('invalid_cursor', 'cursor does not match this time filter');
          }
          keyset = cursor;
        } else {
          if (cursor.kind !== 'offset') {
            throw new TopicSearchError('invalid_cursor', 'cursor does not match this query');
          }
          offset = cursor.offset;
        }
      }

      // 关键词通道（纯日期筛选时没有关键词，直接跳过）
      const keywordScores = new Map<string, { topic: Topic; match: KeywordTopicMatch }>();
      if (hasTokens) {
        for (const topic of candidates) {
          const match = matchTopicByKeyword(topic, tokens);
          if (!match) continue;
          keywordScores.set(topic.topicKey, { topic, match });
        }
      }
      const keywordRanked: RankedKey[] = [...keywordScores.entries()]
        .map(([key, entry]) => ({ key, score: entry.match.score }))
        .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

      // 向量通道（可选；必须有查询词）
      const wantVector = hasTokens && (requestedMode === 'hybrid' || requestedMode === 'auto');
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

      let page: string[];
      let nextCursor: string | null;
      if (!hasTokens && effectiveTimeFilter) {
        // 纯日期筛选：按用户所选口径倒序（最新在前），同值按 topicKey 稳定排序。
        const field = effectiveTimeFilter.field;
        const selectedTime = (topic: Topic): number => Date.parse(topicTimeOf(topic, field) ?? '');
        const sorted = [...candidates]
          .sort((a, b) => selectedTime(b) - selectedTime(a) || a.topicKey.localeCompare(b.topicKey));
        const remaining = keyset
          ? sorted.filter(topic => {
            const at = selectedTime(topic);
            return at < keyset!.time || (at === keyset!.time && topic.topicKey > keyset!.key);
          })
          : sorted;
        const pageTopics = remaining.slice(0, limit);
        page = pageTopics.map(topic => topic.topicKey);
        const last = pageTopics[pageTopics.length - 1];
        nextCursor = remaining.length > limit && last
          ? encodeSearchCursor({
            signature,
            exp: Date.now() + CURSOR_TTL_MS,
            kind: 'keyset',
            field,
            time: selectedTime(last),
            key: last.topicKey,
          })
          : null;
      } else {
        let fused: Map<string, number>;
        if (effectiveMode === 'hybrid' && vectorRanked) {
          fused = reciprocalRankFusion([keywordRanked, vectorRanked]);
        } else {
          fused = new Map(keywordRanked.map(entry => [entry.key, entry.score]));
        }
        const ordered = [...fused.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([key]) => key);
        page = ordered.slice(offset, offset + limit);
        nextCursor = ordered.length > offset + limit
          ? encodeSearchCursor({
            signature,
            exp: Date.now() + CURSOR_TTL_MS,
            kind: 'offset',
            offset: offset + limit,
          })
          : null;
      }

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
          ...(topic.topicCreatedAt ? { topicCreatedAt: topic.topicCreatedAt } : {}),
          ...(topic.latestMessageAt ? { latestMessageAt: topic.latestMessageAt } : {}),
          timeMetadata: topic.timeMetadata,
          ...(pendingVectors > 0 ? { degraded: ['embedding_pending'] } : {}),
        });
      }

      const knownTotal = deps.knownTopicCount?.();
      let coverageState: 'complete' | 'partial' = 'partial';
      let unindexed = 0;
      if (knownTotal === undefined) {
        degradedReasons.push('coverage_unknown');
      } else {
        const stored = visible
          ? allTopics.filter(topic => visible.has(chatIdOf(topic))).length
          : allTopics.length;
        unindexed = Math.max(0, knownTotal - stored);
        coverageState = unindexed === 0 ? 'complete' : 'partial';
      }

      return {
        items,
        effectiveMode,
        degradedReasons: [...new Set(degradedReasons)],
        coverage: {
          state: coverageState,
          unindexedKnownTopics: unindexed,
          unknownTimeTopics,
        },
        nextCursor,
      };
    },
  };
}
