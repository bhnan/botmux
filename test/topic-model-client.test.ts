import { describe, expect, it, vi } from 'vitest';

import {
  createTopicEnricher,
  extractJsonObject,
  parseSummaryMutations,
  TopicModelError,
  type EnrichmentRequest,
} from '../src/topic/model-client.js';

const baseOptions = {
  existingSummaries: [
    { id: 's1', text: '旧摘要', keywords: ['owner'], sourceMessageIds: ['om_1'] },
  ],
  newMessages: [
    { messageId: 'om_2', createTime: '2026-10-01T00:00:02.000Z', text: '新消息' },
    { messageId: 'om_3', createTime: '2026-10-01T00:00:03.000Z', text: '新消息2' },
  ],
  maxSummaryChars: 50,
  maxKeywordsPerSummary: 3,
};

function request(): EnrichmentRequest {
  return {
    topicTitle: '跨 bot owner 校验',
    existingSummaries: baseOptions.existingSummaries,
    newMessages: baseOptions.newMessages,
    maxSummaryChars: baseOptions.maxSummaryChars,
    maxKeywordsPerSummary: baseOptions.maxKeywordsPerSummary,
  };
}

describe('模型输出校验（spec §5.3 的 MUST）', () => {
  it('接受 add / update / noop', () => {
    expect(
      parseSummaryMutations(
        {
          mutations: [
            { op: 'add', text: '新摘要', keywords: ['k'], sourceMessageIds: ['om_2'] },
            { op: 'update', id: 's1', text: '补充', keywords: [], sourceMessageIds: ['om_3'] },
            { op: 'noop' },
          ],
        },
        baseOptions,
      ),
    ).toHaveLength(3);
  });

  it('拒绝未知 id、伪造来源、重复操作、空正文、超长正文、过多关键词', () => {
    const cases: unknown[] = [
      { mutations: [{ op: 'update', id: 'nope', text: 'x', keywords: [], sourceMessageIds: ['om_2'] }] },
      { mutations: [{ op: 'add', text: 'x', keywords: [], sourceMessageIds: ['om_forged'] }] },
      {
        mutations: [
          { op: 'update', id: 's1', text: 'a', keywords: [], sourceMessageIds: ['om_2'] },
          { op: 'update', id: 's1', text: 'b', keywords: [], sourceMessageIds: ['om_3'] },
        ],
      },
      { mutations: [{ op: 'add', text: '   ', keywords: [], sourceMessageIds: ['om_2'] }] },
      { mutations: [{ op: 'add', text: 'x'.repeat(60), keywords: [], sourceMessageIds: ['om_2'] }] },
      { mutations: [{ op: 'add', text: 'ok', keywords: ['a', 'b', 'c', 'd'], sourceMessageIds: ['om_2'] }] },
      { mutations: [{ op: 'delete', id: 's1' }] },
      { notMutations: [] },
    ];
    for (const payload of cases) {
      expect(() => parseSummaryMutations(payload, baseOptions), JSON.stringify(payload)).toThrow(TopicModelError);
    }
  });

  it('空 mutations 视为显式 noop（没有可提取内容也要落一个确定操作）', () => {
    expect(parseSummaryMutations({ mutations: [] }, baseOptions)).toEqual([{ op: 'noop' }]);
  });

  it('容忍代码围栏与前后解释文字', () => {
    expect(extractJsonObject('```json\n{"mutations":[]}\n```')).toEqual({ mutations: [] });
    expect(extractJsonObject('好的，结果如下：{"mutations":[{"op":"noop"}]} 以上。')).toEqual({
      mutations: [{ op: 'noop' }],
    });
    expect(extractJsonObject('完全不是 JSON')).toBeUndefined();
  });
});

describe('摘要模型客户端', () => {
  const endpoint = {
    baseUrl: 'https://llm.example.com/v1',
    model: 'enricher-1',
    timeoutMs: 5_000,
    maxRetries: 2,
    maxOutputChars: 2_000,
  };

  it('成功调用解析出 mutations，并用 provider/model 组成 generatorKey', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  mutations: [{ op: 'add', text: '新增摘要', keywords: ['k'], sourceMessageIds: ['om_2'] }],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const enricher = createTopicEnricher(endpoint, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await enricher.enrich(request());
    expect(result.mutations).toHaveLength(1);
    expect(result.generatorKey).toBe('enricher-1@v1');
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.model).toBe('enricher-1');
    expect(body.messages[0].role).toBe('system');
  });

  it('429 退避后重试成功', async () => {
    const responses = [
      new Response('rate limited', { status: 429 }),
      new Response(JSON.stringify({ choices: [{ message: { content: '{"mutations":[{"op":"noop"}]}' } }] }), {
        status: 200,
      }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift() as Response);
    const sleep = vi.fn(async () => {});
    const enricher = createTopicEnricher(endpoint, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });
    await expect(enricher.enrich(request())).resolves.toMatchObject({ mutations: [{ op: 'noop' }] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('鉴权失败不重试（重试也只会继续 401）', async () => {
    const fetchImpl = vi.fn(async () => new Response('denied', { status: 401 }));
    const enricher = createTopicEnricher(endpoint, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(enricher.enrich(request())).rejects.toMatchObject({ code: 'auth', retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('非 JSON 响应体与非法输出都失败，不猜内容', async () => {
    const notJson = createTopicEnricher(endpoint, {
      fetchImpl: (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch,
    });
    await expect(notJson.enrich(request())).rejects.toMatchObject({ code: 'invalid_json' });

    const badShape = createTopicEnricher(endpoint, {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"nope":1}' } }] }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    await expect(badShape.enrich(request())).rejects.toMatchObject({ code: 'invalid_output' });
  });
});
