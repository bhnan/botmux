/**
 * `POST /api/topic-search` 的请求适配层（一期唯一对外入口）。
 *
 * 一期不新增端口、不新增进程、不新增 CLI/Skill：这个 handler 由 Dashboard 主 server
 * 在**现有认证 gate 之后**用同一个 `req/res` 调用，因此天生复用 Dashboard 的登录、
 * cookie/H5 身份与访问策略——它既拿不到也不判断任何 token。
 *
 * 边界（与 spec §6.2 对齐）：
 * - 只做「解析/校验请求 → 调 SearchService → 映射错误码」，不实现检索算法；
 * - 访问范围由 Dashboard 侧注入（`authorize`），这里只做「filters 不能扩大范围」；
 * - 响应不得包含凭证、原始向量、内部 prompt 或未授权源 id（SearchService 已保证）。
 */

import type { IncomingMessage } from 'node:http';

import {
  TopicSearchError,
  type TopicSearchFilters,
  type TopicSearchMode,
  type TopicSearchQuery,
  type TopicSearchResponse,
  type TopicSearchService,
  type TopicTimeField,
  type TopicTimeFilter,
} from '../topic/search.js';
import type { ResolvedTopicSearchConfig } from '../topic/config.js';

export const TOPIC_SEARCH_ROUTE = '/api/topic-search';

/** Dashboard 侧给出的访问决定：要么给出可见群范围，要么明确拒绝。 */
export type TopicSearchAccessDecision =
  | {
    ok: true;
    /**
     * 可选的可见群范围。省略 = Dashboard 已认证，可读全部已保留历史话题；
     * 这里不是「更新范围」（`topicSearch.allowedChatIds`），群移出更新范围后
     * 旧摘要仍应可检索。
     */
    visibleChatIds?: readonly string[];
  }
  | { ok: false; status: 401 | 403; error: string };

export interface TopicSearchRouteDeps {
  /** 访问决定（Dashboard 认证 gate 的投影）。 */
  authorize: (input: { method: string; pathname: string }) => TopicSearchAccessDecision;
  search: TopicSearchService['search'];
  /** 功能开关（关闭时用原列表，接口返回 403）。 */
  config: () => ResolvedTopicSearchConfig;
  /** 复用 Dashboard 的 body 读取（带大小上限）；缺省自行读取。 */
  readJsonBody?: (req: IncomingMessage, maxBytes?: number) => Promise<unknown>;
  now?: () => string;
}

export interface TopicSearchHttpResult {
  status: number;
  body: Record<string, unknown>;
}

const MAX_BODY_BYTES = 256 * 1024;
const MAX_QUERY_CHARS = 200;
const MAX_LIMIT = 50;

async function readBody(req: IncomingMessage, reader?: TopicSearchRouteDeps['readJsonBody']): Promise<unknown> {
  if (reader) return reader(req, MAX_BODY_BYTES);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error('body_too_large');
    chunks.push(buffer);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function parseFilters(raw: unknown): TopicSearchFilters | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TopicSearchError('invalid_filter', 'filters must be an object');
  }
  const record = raw as Record<string, unknown>;
  const filters: TopicSearchFilters = {};
  if (record.chatIds !== undefined) {
    if (!Array.isArray(record.chatIds) || record.chatIds.some(id => typeof id !== 'string')) {
      throw new TopicSearchError('invalid_filter', 'filters.chatIds must be string[]');
    }
    filters.chatIds = record.chatIds as string[];
  }
  for (const key of ['sourceFrom', 'sourceTo'] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string') {
      throw new TopicSearchError('invalid_filter', `filters.${key} must be an ISO-8601 string or null`);
    }
    filters[key] = value as string | null;
  }
  return filters;
}

function parseTimeFilter(raw: unknown): TopicTimeFilter | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TopicSearchError('invalid_filter', 'timeFilter must be an object');
  }
  const record = raw as Record<string, unknown>;
  if (record.field !== 'created' && record.field !== 'latestMessage') {
    throw new TopicSearchError('invalid_filter', 'timeFilter.field must be created/latestMessage');
  }
  const filter: TopicTimeFilter = { field: record.field as TopicTimeField };
  for (const key of ['from', 'to'] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string') {
      throw new TopicSearchError('invalid_filter', `timeFilter.${key} must be an ISO-8601 string or null`);
    }
    if (typeof value === 'string' && Number.isNaN(Date.parse(value))) {
      throw new TopicSearchError('invalid_filter', `timeFilter.${key} must be an ISO-8601 timestamp`);
    }
    filter[key] = value as string | null;
  }
  if (!filter.from && !filter.to) {
    // 只选了口径、没给范围：视为未启用时间筛选，避免静默按「全部时间」返回。
    return undefined;
  }
  return filter;
}

/** 请求体 → 查询对象。纯函数，便于直接测错误码。 */
export function parseTopicSearchRequestBody(body: unknown): TopicSearchQuery {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TopicSearchError('invalid_query', 'body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query.trim() : '';
  if (record.query !== undefined && typeof record.query !== 'string') {
    throw new TopicSearchError('invalid_query', 'query must be a string');
  }
  if (query.length > MAX_QUERY_CHARS) throw new TopicSearchError('invalid_query', 'query is too long');
  const timeFilter = parseTimeFilter(record.timeFilter);
  if (!query && !timeFilter) {
    throw new TopicSearchError('invalid_query', 'query or timeFilter is required');
  }

  let limit: number | undefined;
  if (record.limit !== undefined) {
    if (typeof record.limit !== 'number' || !Number.isFinite(record.limit)) {
      throw new TopicSearchError('invalid_limit', 'limit must be a number');
    }
    if (record.limit < 1 || record.limit > MAX_LIMIT) {
      throw new TopicSearchError('invalid_limit', `limit must be within 1..${MAX_LIMIT}`);
    }
    limit = Math.floor(record.limit);
  }

  const mode = record.mode;
  if (mode !== undefined && mode !== 'keyword' && mode !== 'hybrid' && mode !== 'auto') {
    throw new TopicSearchError('invalid_query', 'mode must be keyword/hybrid/auto');
  }
  const cursor = record.cursor;
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') {
    throw new TopicSearchError('invalid_cursor', 'cursor must be a string');
  }

  const filters = parseFilters(record.filters);
  return {
    query,
    ...(filters ? { filters } : {}),
    ...(timeFilter ? { timeFilter } : {}),
    ...(mode ? { mode: mode as TopicSearchMode } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor: cursor as string | null }),
  };
}

function statusFor(error: TopicSearchError): number {
  switch (error.code) {
    case 'forbidden':
      return 403;
    case 'budget_exceeded':
      return 429;
    case 'invalid_cursor':
      // 游标失效要求调用方重新查询（而不是重试同一个游标）。
      return 400;
    default:
      return 400;
  }
}

/**
 * 处理一次请求。返回 `null` 表示「不是这个路由」（交给后面的 Dashboard 路由继续匹配）。
 */
export async function handleTopicSearchRequest(
  req: IncomingMessage,
  url: URL,
  deps: TopicSearchRouteDeps,
): Promise<TopicSearchHttpResult | null> {
  if (url.pathname !== TOPIC_SEARCH_ROUTE) return null;
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };

  const access = deps.authorize({ method, pathname: url.pathname });
  if (!access.ok) return { status: access.status, body: { ok: false, error: access.error } };

  const config = deps.config();
  if (!config.enabled) {
    // 功能关闭：页面回退到原列表，接口明确拒绝（不返回空结果假装「没检索到」）。
    return { status: 403, body: { ok: false, error: 'disabled' } };
  }

  let body: unknown;
  try {
    body = await readBody(req, deps.readJsonBody);
  } catch (error) {
    const tooLarge = (error as Error)?.message === 'body_too_large';
    return {
      status: tooLarge ? 413 : 400,
      body: { ok: false, error: tooLarge ? 'body_too_large' : 'bad_json' },
    };
  }

  let query: TopicSearchQuery;
  try {
    query = parseTopicSearchRequestBody(body);
  } catch (error) {
    const searchError = error as TopicSearchError;
    return { status: statusFor(searchError), body: { ok: false, error: searchError.code } };
  }

  try {
    const result: TopicSearchResponse = await deps.search(query, {
      ...(access.visibleChatIds ? { visibleChatIds: access.visibleChatIds } : {}),
    });
    const now = deps.now ?? (() => new Date().toISOString());
    return { status: 200, body: { ok: true, generatedAt: now(), ...result } };
  } catch (error) {
    if (error instanceof TopicSearchError) {
      return { status: statusFor(error), body: { ok: false, error: error.code } };
    }
    // 内部错误不回细节（可能含路径/模型信息）。
    return { status: 503, body: { ok: false, error: 'search_unavailable' } };
  }
}
