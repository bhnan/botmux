import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import {
  handleTopicSearchRequest,
  parseTopicSearchRequestBody,
  TOPIC_SEARCH_ROUTE,
  type TopicSearchRouteDeps,
} from '../src/dashboard/topic-search-api.js';
import { TopicSearchError } from '../src/topic/search.js';
import { TOPIC_SEARCH_DEFAULT_CONFIG, type ResolvedTopicSearchConfig } from '../src/topic/config.js';

const enabledConfig: ResolvedTopicSearchConfig = {
  ...TOPIC_SEARCH_DEFAULT_CONFIG,
  enabled: true,
  allowedChatIds: ['oc_1'],
  llmModelRef: 'topic-enricher',
};

const searchResult = {
  items: [
    {
      topicKey: 'thread:oc_1:om_1',
      title: '跨 bot owner 校验',
      matches: [{ summaryId: 's1', text: '命中摘要', sourceMessageIds: ['om_1'] }],
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  effectiveMode: 'keyword' as const,
  degradedReasons: [],
  coverage: { state: 'complete' as const, unindexedKnownTopics: 0 },
  nextCursor: null,
};

function deps(overrides: Partial<TopicSearchRouteDeps> = {}): TopicSearchRouteDeps {
  return {
    authorize: () => ({ ok: true, allowedChatIds: ['oc_1'] }),
    search: vi.fn(async () => searchResult),
    config: () => enabledConfig,
    // 注入 body 读取，测试里完全绕开真实 socket。
    readJsonBody: async () => ({ query: 'owner' }),
    now: () => '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function url(pathname = TOPIC_SEARCH_ROUTE): URL {
  return new URL(pathname, 'http://127.0.0.1:1');
}

const req = (method = 'POST') => ({ method } as unknown as IncomingMessage);

describe('话题检索路由：路由与鉴权', () => {
  it('不是这个路径时返回 null（交给 Dashboard 后续路由）', async () => {
    expect(await handleTopicSearchRequest(req(), url('/api/sessions'), deps())).toBeNull();
  });

  it('非 POST 返回 405', async () => {
    const result = await handleTopicSearchRequest(req('GET'), url(), deps());
    expect(result).toMatchObject({ status: 405, body: { ok: false, error: 'method_not_allowed' } });
  });

  it('访问决定为拒绝时原样透传状态与错误码（未登录/越权）', async () => {
    const denied = await handleTopicSearchRequest(
      req(),
      url(),
      deps({ authorize: () => ({ ok: false, status: 403, error: 'sensitive_history_denied' }) }),
    );
    expect(denied).toMatchObject({ status: 403, body: { ok: false, error: 'sensitive_history_denied' } });
  });

  it('功能未启用时返回 403 disabled（页面据此回退原列表）', async () => {
    const result = await handleTopicSearchRequest(
      req(),
      url(),
      deps({ config: () => ({ ...enabledConfig, enabled: false }) }),
    );
    expect(result).toMatchObject({ status: 403, body: { ok: false, error: 'disabled' } });
  });
});

describe('话题检索路由：请求校验', () => {
  it('body 不是 JSON 时 400，超限时 413', async () => {
    const badJson = await handleTopicSearchRequest(
      req(),
      url(),
      deps({
        readJsonBody: async () => {
          throw new Error('bad');
        },
      }),
    );
    expect(badJson).toMatchObject({ status: 400, body: { ok: false, error: 'bad_json' } });

    const tooLarge = await handleTopicSearchRequest(
      req(),
      url(),
      deps({
        readJsonBody: async () => {
          throw new Error('body_too_large');
        },
      }),
    );
    expect(tooLarge).toMatchObject({ status: 413, body: { ok: false, error: 'body_too_large' } });
  });

  it('空/超长 query、limit 越界、未知 mode、filters 形状错误各有明确错误码', () => {
    for (const body of [
      {},
      { query: '   ' },
      { query: 'x'.repeat(201) },
      { query: 'ok', limit: 0 },
      { query: 'ok', limit: 51 },
      { query: 'ok', mode: 'semantic' },
      { query: 'ok', filters: { chatIds: 'oc_1' } },
      { query: 'ok', filters: { sourceFrom: 42 } },
      { query: 'ok', cursor: 7 },
    ]) {
      expect(() => parseTopicSearchRequestBody(body), JSON.stringify(body)).toThrow(TopicSearchError);
    }
  });

  it('合法请求解析出规范化的查询对象', () => {
    expect(
      parseTopicSearchRequestBody({
        query: '  跨 bot owner  ',
        mode: 'hybrid',
        limit: 3,
        filters: { chatIds: ['oc_1'], sourceFrom: '2026-10-01T00:00:00Z', sourceTo: null },
        cursor: null,
      }),
    ).toEqual({
      query: '跨 bot owner',
      mode: 'hybrid',
      limit: 3,
      filters: { chatIds: ['oc_1'], sourceFrom: '2026-10-01T00:00:00Z', sourceTo: null },
      cursor: null,
    });
  });
});

describe('话题检索路由：响应与错误映射', () => {
  it('成功时返回 ok + 检索结果，并把访问范围传给 SearchService', async () => {
    const search = vi.fn(async () => searchResult);
    const result = await handleTopicSearchRequest(
      req(),
      url(),
      deps({
        search,
        authorize: () => ({ ok: true, allowedChatIds: ['oc_1', 'oc_2'] }),
        readJsonBody: async () => ({ query: 'owner', mode: 'keyword', limit: 2 }),
      }),
    );
    expect(result?.status).toBe(200);
    expect(result?.body).toMatchObject({ ok: true, generatedAt: '2026-10-01T00:00:00.000Z', ...searchResult });
    expect(search).toHaveBeenCalledWith(
      { query: 'owner', mode: 'keyword', limit: 2 },
      { allowedChatIds: ['oc_1', 'oc_2'] },
    );
  });

  it('检索层错误映射为 403/429/400，未知异常映射 503 且不泄露细节', async () => {
    const forbidden = await handleTopicSearchRequest(
      req(),
      url(),
      deps({
        search: async () => {
          throw new TopicSearchError('forbidden', 'nope');
        },
      }),
    );
    expect(forbidden).toMatchObject({ status: 403, body: { error: 'forbidden' } });

    const budget = await handleTopicSearchRequest(
      req(),
      url(),
      deps({
        search: async () => {
          throw new TopicSearchError('budget_exceeded', 'too much');
        },
      }),
    );
    expect(budget).toMatchObject({ status: 429, body: { error: 'budget_exceeded' } });

    const cursor = await handleTopicSearchRequest(
      req(),
      url(),
      deps({
        search: async () => {
          throw new TopicSearchError('invalid_cursor', 'stale');
        },
      }),
    );
    expect(cursor).toMatchObject({ status: 400, body: { error: 'invalid_cursor' } });

    const boom = await handleTopicSearchRequest(
      req(),
      url(),
      deps({
        search: async () => {
          throw new Error('sqlite: /Users/someone/.botmux/topic-search.sqlite is locked');
        },
      }),
    );
    expect(boom).toMatchObject({ status: 503, body: { ok: false, error: 'search_unavailable' } });
    expect(JSON.stringify(boom?.body)).not.toContain('.botmux');
  });
});
