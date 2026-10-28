/** 摘要与 embedding 模型 client 行为回归（spec §5.3/§4，假 provider）：
 *  - 一次结构化调用返回 add/update/noop；输出严格校验：未知 id/伪造来源/畸形 op 整批拒绝
 *  - 代码围栏容错；429/5xx 有限重试；401 不重试；超时归类 timeout
 *  - 引用集合 = 本批新消息 ∪ 旧摘要来源；模型输出的 keywords 归一小写
 *  - embedding：维度不符硬错不重试；非数值向量拒绝；modelKey 一致
 */
import { describe, it, expect } from 'vitest';
import { callSummaryModel, type TopicModelMessage } from '../src/topic/model-client.js';
import { embedSummaryText } from '../src/topic/embedding-client.js';
import type { TopicModelProfile } from '../src/topic/config.js';

const profile: TopicModelProfile = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-mini',
  apiKeyEnv: 'TOPIC_TEST_KEY',
  timeoutMs: 5_000,
  maxRetries: 2,
};

const env = { TOPIC_TEST_KEY: 'sk-test-1234' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function chatCompletion(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] });
}

const newMessages: TopicModelMessage[] = [
  { messageId: 'om_1', senderName: 'alice', createTime: '2026-10-29T01:00:00Z', text: '部署失败了，报错 ERR_CODE_X' },
  { messageId: 'om_2', senderName: 'bob', text: '回滚到上个版本解决' },
];

const oldSummaries = [
  { id: 'ts_old1', text: '之前的部署摘要', keywords: ['deploy'], sourceMessageIds: ['om_0'] },
];

function input(overrides: Record<string, unknown> = {}) {
  return { topicTitle: '部署话题', oldSummaries, newMessages, ...overrides } as Parameters<typeof callSummaryModel>[1];
}

describe('callSummaryModel', () => {
  it('合法 add/update/noop 输出通过并透传；带代码围栏也能解析', async () => {
    const plain = await callSummaryModel(profile, input(), {
      env,
      fetchImpl: async () => chatCompletion(JSON.stringify({
        mutations: [
          { op: 'add', text: '部署失败 ERR_CODE_X 后回滚解决', keywords: ['ERR_CODE_X', 'Rollback'], sourceMessageIds: ['om_1', 'om_2'] },
          { op: 'noop' },
        ],
      })),
    });
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.mutations).toHaveLength(2);
    expect(plain.mutations[0]).toMatchObject({ op: 'add', sourceMessageIds: ['om_1', 'om_2'] });
    expect(plain.mutations[0].keywords).toEqual(['err_code_x', 'rollback']); // 小写归一
    expect(plain.generatorKey).toBe('openai-compatible/gpt-mini');

    const fenced = await callSummaryModel(profile, input(), {
      env,
      fetchImpl: async () => chatCompletion('```json\n{"mutations":[{"op":"noop"}]}\n```'),
    });
    expect(fenced.ok).toBe(true);
  });

  it('update 可引用旧摘要；旧摘要的来源消息 id 也是合法引用', async () => {
    const result = await callSummaryModel(profile, input(), {
      env,
      fetchImpl: async () => chatCompletion(JSON.stringify({
        mutations: [{ op: 'update', id: 'ts_old1', text: '之前的部署摘要（补充回滚）', keywords: ['deploy'], sourceMessageIds: ['om_0', 'om_2'] }],
      })),
    });
    expect(result.ok).toBe(true);
  });

  it('未知 summary id / 伪造来源消息 id / 畸形 op ⇒ 整批拒绝', async () => {
    const unknownId = await callSummaryModel(profile, input(), {
      env,
      fetchImpl: async () => chatCompletion(JSON.stringify({ mutations: [{ op: 'update', id: 'ts_fabricated', text: 'x', keywords: [], sourceMessageIds: ['om_1'] }] })),
    });
    expect(unknownId).toEqual({ ok: false, code: 'unknown_summary_id' });

    const fabricatedRef = await callSummaryModel(profile, input(), {
      env,
      fetchImpl: async () => chatCompletion(JSON.stringify({ mutations: [{ op: 'add', text: 'x', keywords: [], sourceMessageIds: ['om_FROM_OTHER_TOPIC'] }] })),
    });
    expect(fabricatedRef).toEqual({ ok: false, code: 'fabricated_source_refs' });

    const badOp = await callSummaryModel(profile, input(), {
      env,
      fetchImpl: async () => chatCompletion(JSON.stringify({ mutations: [{ op: 'delete', id: 'ts_old1' }] })),
    });
    expect(badOp).toEqual({ ok: false, code: 'invalid_mutations' });

    const emptyText = await callSummaryModel(profile, input(), {
      env,
      fetchImpl: async () => chatCompletion(JSON.stringify({ mutations: [{ op: 'add', text: '', keywords: [], sourceMessageIds: ['om_1'] }] })),
    });
    expect(emptyText).toEqual({ ok: false, code: 'invalid_mutations' });
  });

  it('非 JSON / 缺 mutations ⇒ invalid_output（不重试）', async () => {
    let calls = 0;
    const result = await callSummaryModel(profile, input(), {
      env,
      fetchImpl: async () => {
        calls++;
        return chatCompletion('我觉得应该总结一下部署的教训。');
      },
    });
    expect(result).toEqual({ ok: false, code: 'invalid_output' });
    expect(calls).toBe(1);
  });

  it('401 不重试；429 先重试后成功；连续 5xx 耗尽重试报 http_error', async () => {
    const unauthorized = await callSummaryModel(profile, input(), {
      env,
      fetchImpl: async () => jsonResponse({ error: 'bad key' }, 401),
    });
    expect(unauthorized).toEqual({ ok: false, code: 'unauthorized' });

    let calls = 0;
    const retried = await callSummaryModel(profile, input(), {
      env,
      fetchImpl: async () => {
        calls++;
        return calls === 1 ? jsonResponse({}, 429) : chatCompletion(JSON.stringify({ mutations: [{ op: 'noop' }] }));
      },
    });
    expect(retried.ok).toBe(true);
    expect(calls).toBe(2);

    let failing = 0;
    const exhausted = await callSummaryModel({ ...profile, maxRetries: 1 }, input(), {
      env,
      fetchImpl: async () => {
        failing++;
        return jsonResponse({}, 503);
      },
    });
    expect(exhausted).toEqual({ ok: false, code: 'http_error' });
    expect(failing).toBe(2); // 首次 + 1 次重试
  });

  it('空输入 / 超预算输入直接拒绝', async () => {
    const empty = await callSummaryModel(profile, input({ newMessages: [] }), { env, fetchImpl: async () => { throw new Error('must not fetch'); } });
    expect(empty).toEqual({ ok: false, code: 'input_empty' });

    const big = await callSummaryModel({ ...profile, maxInputChars: 1_000 }, {
      topicTitle: 't',
      oldSummaries: [],
      newMessages: [{ messageId: 'om_1', text: 'x'.repeat(2_000) }],
    }, { env, fetchImpl: async () => { throw new Error('must not fetch'); } });
    expect(big).toEqual({ ok: false, code: 'input_too_large' });
  });

  it('请求带注入 env 的 Bearer；网络超时归类 timeout', async () => {
    let authHeader: string | undefined;
    await callSummaryModel(profile, input(), {
      env,
      fetchImpl: async (_url, init) => {
        authHeader = (init?.headers as Record<string, string>)?.Authorization;
        return chatCompletion(JSON.stringify({ mutations: [{ op: 'noop' }] }));
      },
    });
    expect(authHeader).toBe('Bearer sk-test-1234');

    const timeout = new Error('aborted');
    timeout.name = 'TimeoutError';
    const timed = await callSummaryModel(profile, input(), {
      env,
      fetchImpl: async () => { throw timeout; },
    });
    expect(timed).toEqual({ ok: false, code: 'timeout' });
  });
});

describe('embedSummaryText', () => {
  const embProfile: TopicModelProfile = {
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    model: 'emb-1',
    apiKeyEnv: 'TOPIC_TEST_KEY',
    dimensions: 4,
  };

  it('合法向量返回并带 modelKey', async () => {
    const result = await embedSummaryText(embProfile, '摘要正文', {
      env,
      fetchImpl: async () => jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }),
    });
    expect(result).toEqual({ ok: true, vector: [0.1, 0.2, 0.3, 0.4], modelKey: 'openai-compatible/emb-1:4' });
  });

  it('维度不符硬错且不重试（不得混用向量空间）', async () => {
    let calls = 0;
    const result = await embedSummaryText(embProfile, 'x', {
      env,
      fetchImpl: async () => {
        calls++;
        return jsonResponse({ data: [{ embedding: [0.1, 0.2] }] });
      },
    });
    expect(result).toEqual({ ok: false, code: 'dimension_mismatch' });
    expect(calls).toBe(1);
  });

  it('非数值/空向量拒绝；401 拒绝', async () => {
    const nan = await embedSummaryText(embProfile, 'x', {
      env,
      fetchImpl: async () => jsonResponse({ data: [{ embedding: [0.1, 'oops', 0.3, 0.4] }] }),
    });
    expect(nan).toEqual({ ok: false, code: 'not_a_number_vector' });

    const empty = await embedSummaryText(embProfile, 'x', {
      env,
      fetchImpl: async () => jsonResponse({ data: [{}] }),
    });
    expect(empty).toEqual({ ok: false, code: 'not_a_number_vector' });

    const unauthorized = await embedSummaryText(embProfile, 'x', {
      env,
      fetchImpl: async () => jsonResponse({}, 403),
    });
    expect(unauthorized).toEqual({ ok: false, code: 'unauthorized' });
  });
});
