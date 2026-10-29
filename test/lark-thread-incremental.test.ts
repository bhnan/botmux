/**
 * `listThreadMessagesIncremental`（话题增量读取契约）的行为钉死。
 *
 * 这条函数是「定时摘要」唯一的历史入口，它错在哪一边都会造成静默数据问题：
 * - 该停不停 → 每轮重复送一遍旧消息，模型费用翻倍；
 * - 不该停却停/范围没覆盖就报 complete → 游标跨过读不到的中间段，那段消息永久丢失。
 *
 * 所以这里对「请求参数序列、提前终止后的请求次数、边界判定、同毫秒去重、预算与取消」
 * 逐条断言。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const state = {
    /** 合成会话，oldest -> newest */
    messages: [] as any[],
    /** message.get 是否能解析出 thread_id（快路径 / 回落路径） */
    threadIdResolvable: true,
    listCalls: [] as Array<Record<string, unknown>>,
  };
  const ROOT = 'om_root';

  class MockClient {
    async request({ url, params }: { url: string; params?: any }) {
      if (/\/open-apis\/im\/v1\/messages\/[^/]+$/.test(url)) {
        return {
          code: 0,
          data: { items: [{ message_id: ROOT, thread_id: state.threadIdResolvable ? 'omt_x' : undefined }] },
        };
      }
      if (url === '/open-apis/im/v1/messages') {
        state.listCalls.push({ ...params });
        const pageSize = Number(params?.page_size ?? 50);
        const ordered = params?.sort_type === 'ByCreateTimeDesc' ? [...state.messages].reverse() : [...state.messages];
        const offset = params?.page_token ? Number(params.page_token) : 0;
        const next = offset + pageSize;
        return {
          code: 0,
          data: {
            items: ordered.slice(offset, offset + pageSize),
            ...(next < ordered.length ? { page_token: String(next) } : {}),
          },
        };
      }
      throw new Error(`unexpected url in mock: ${url}`);
    }
  }
  return { state, MockClient, ROOT };
});
const { state, MockClient, ROOT } = hoisted;

vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return '/tmp/botmux-test'; } } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/utils/user-token.js', () => ({ resolveUserToken: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({
  loadBotConfigs: vi.fn(() => []),
  getBotClient: vi.fn(() => new MockClient()),
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({ LoggerLevel: { error: 4 }, Client: MockClient }));

const BASE_MS = 1_700_000_000_000;

/** n 条消息 m001..；每第 `otherEvery` 条不属于 ROOT（回落路径过滤用）。 */
function build(n: number, opts: { otherEvery?: number } = {}) {
  state.messages = Array.from({ length: n }, (_, i) => {
    const other = opts.otherEvery !== undefined && (i + 1) % opts.otherEvery === 0;
    return {
      message_id: `m${String(i + 1).padStart(3, '0')}`,
      root_id: other ? 'om_other' : ROOT,
      create_time: String(BASE_MS + i * 1000),
    };
  });
}
const ids = (msgs: any[]) => msgs.map(m => m.message_id);
const timeOf = (id: string) => {
  const message = state.messages.find(item => item.message_id === id);
  return Number(message?.create_time);
};

beforeEach(() => {
  state.listCalls = [];
  state.threadIdResolvable = true;
  build(130);
});

describe('listThreadMessagesIncremental', () => {
  it('首轮回填按预算取尾部，预算用尽时 complete=false（还有更早的没读到）', async () => {
    const { listThreadMessagesIncremental } = await import('../src/im/lark/client.js');
    const result = await listThreadMessagesIncremental('cli_x', 'oc_1', ROOT, { maxMessages: 50 });
    expect(ids(result.messages)).toEqual(
      Array.from({ length: 50 }, (_, i) => `m${String(81 + i).padStart(3, '0')}`),
    );
    expect(result.complete).toBe(false);
    expect(result.verifiedThread).toBe(true);
    expect(result.threadId).toBe('omt_x');
  });

  it('预算足够时翻到容器开头，complete=true', async () => {
    const { listThreadMessagesIncremental } = await import('../src/im/lark/client.js');
    const result = await listThreadMessagesIncremental('cli_x', 'oc_1', ROOT, { maxMessages: 200 });
    expect(result.messages).toHaveLength(130);
    expect(result.complete).toBe(true);
    expect(ids(result.messages).slice(0, 2)).toEqual(['m001', 'm002']);
  });

  it('边界早于容器第一条消息时，翻到开头也算完整覆盖（重叠核查窗口）', async () => {
    const { listThreadMessagesIncremental } = await import('../src/im/lark/client.js');
    const result = await listThreadMessagesIncremental('cli_x', 'oc_1', ROOT, {
      maxMessages: 200,
      afterTimeMs: BASE_MS - 24 * 60 * 60_000,
      afterMessageIds: [],
    });
    expect(result.messages).toHaveLength(130);
    expect(result.complete).toBe(true);
  });

  it('遇到处理边界就停：只返回边界之后的增量，且不再多取一页', async () => {
    const { listThreadMessagesIncremental } = await import('../src/im/lark/client.js');
    const result = await listThreadMessagesIncremental('cli_x', 'oc_1', ROOT, {
      maxMessages: 200,
      afterTimeMs: timeOf('m100'),
      afterMessageIds: ['m100'],
    });
    expect(ids(result.messages)[0]).toBe('m101');
    expect(result.messages).toHaveLength(30);
    expect(result.complete).toBe(true);
    expect(state.listCalls).toHaveLength(1);
  });

  it('边界毫秒上已处理的 id 用集合去重：同毫秒的新消息不会被吞掉', async () => {
    // m100 与 m101 同毫秒；游标只处理过 m100。
    state.messages = state.messages.map(message =>
      message.message_id === 'm101' ? { ...message, create_time: timeOf('m100') } : message,
    );
    const { listThreadMessagesIncremental } = await import('../src/im/lark/client.js');
    const result = await listThreadMessagesIncremental('cli_x', 'oc_1', ROOT, {
      maxMessages: 200,
      afterTimeMs: timeOf('m100'),
      afterMessageIds: ['m100'],
    });
    expect(ids(result.messages)).toContain('m101');
    expect(result.complete).toBe(true);
  });

  it('预算不足以覆盖到边界时 complete=false（调用方不得推进游标）', async () => {
    const { listThreadMessagesIncremental } = await import('../src/im/lark/client.js');
    const result = await listThreadMessagesIncremental('cli_x', 'oc_1', ROOT, {
      maxMessages: 5,
      afterTimeMs: timeOf('m001'),
      afterMessageIds: ['m001'],
    });
    expect(result.messages).toHaveLength(5);
    expect(result.complete).toBe(false);
  });

  it('已取消的信号不发任何请求', async () => {
    const { listThreadMessagesIncremental } = await import('../src/im/lark/client.js');
    const controller = new AbortController();
    controller.abort();
    await expect(
      listThreadMessagesIncremental('cli_x', 'oc_1', ROOT, { maxMessages: 10, signal: controller.signal }),
    ).rejects.toThrow();
    // message.get（解析 thread id）在第一次翻页前就 aborted？这里只保证不发 list 请求。
    expect(state.listCalls).toHaveLength(0);
  });

  it('退化路径（拿不到 omt_ id）按 root_id 过滤，不把整群消息当成话题增量', async () => {
    state.threadIdResolvable = false;
    build(20, { otherEvery: 2 });
    const { listThreadMessagesIncremental } = await import('../src/im/lark/client.js');
    const result = await listThreadMessagesIncremental('cli_x', 'oc_1', ROOT, { maxMessages: 10 });
    expect(result.verifiedThread).toBe(false);
    for (const message of result.messages) expect(message.root_id).toBe(ROOT);
    expect(state.listCalls[0].container_id_type).toBe('chat');
  });
});
