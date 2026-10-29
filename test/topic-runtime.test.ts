import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTopicRuntime, type TopicRuntimeDeps } from '../src/topic/runtime.js';
import type { TopicEnricher } from '../src/topic/model-client.js';
import type { TopicHistoryReader, TopicSourceMessage } from '../src/topic/source.js';
import { openTopicStore, type TopicStore } from '../src/topic/store.js';

let dir: string;
let store: TopicStore;

const entry = {
  chatId: 'oc_1',
  rootMessageId: 'om_1',
  title: '跨 bot owner 校验',
  accessPolicyRef: 'deployment:topic-search',
};

function message(messageId: string, second: number, text: string): TopicSourceMessage {
  return {
    messageId,
    createTime: new Date(Date.parse('2026-10-01T00:00:00.000Z') + second * 1000).toISOString(),
    text,
  };
}

function source(messages: TopicSourceMessage[], entries = [entry]): TopicHistoryReader & {
  readMessages: ReturnType<typeof vi.fn>;
} {
  const readMessages = vi.fn(async () => ({ messages, truncated: false }));
  return { discoverTopics: async () => entries, readMessages } as never;
}

const enricher: TopicEnricher = {
  generatorKey: 'test-model@v1',
  enrich: async () => ({
    mutations: [
      {
        op: 'add',
        text: '决定把跨 bot owner 校验放到 setup 层',
        keywords: ['owner', 'setup'],
        sourceMessageIds: ['om_1'],
      },
    ],
    generatorKey: 'test-model@v1',
  }),
};

function runtime(overrides: Partial<TopicRuntimeDeps> = {}) {
  return createTopicRuntime({
    readConfig: () => ({
      enabled: true,
      allowedChatIds: ['oc_1'],
      llmModelRef: 'topic-enricher',
    }),
    source: source([message('om_1', 1, '讨论跨 bot owner 校验')]),
    resolveEnricher: () => enricher,
    resolveEmbedder: () => null,
    store,
    now: () => '2026-10-01T00:00:00.000Z',
    ...overrides,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'topic-runtime-test-'));
  store = openTopicStore({ path: join(dir, 'topics.sqlite') });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('runtime 装配', () => {
  it('关闭时不启动调度、不碰库', async () => {
    const rt = createTopicRuntime({
      readConfig: () => ({ enabled: false }),
      source: source([], []),
      store,
      now: () => '2026-10-01T00:00:00.000Z',
    });
    expect(rt.config().config.enabled).toBe(false);
    rt.start();
    expect(rt.isRunning()).toBe(false);
    await expect(rt.runOnce()).rejects.toMatchObject({ code: 'disabled' });
  });

  it('缺少群范围或模型引用时拒绝启动（不静默跑）', async () => {
    const noChats = createTopicRuntime({
      readConfig: () => ({ enabled: true, llmModelRef: 'm' }),
      source: source([], []),
      store,
    });
    noChats.start();
    expect(noChats.isRunning()).toBe(false);

    const noModel = createTopicRuntime({
      readConfig: () => ({ enabled: true, allowedChatIds: ['oc_1'] }),
      source: source([], []),
      store,
    });
    noModel.start();
    expect(noModel.isRunning()).toBe(false);
  });

  it('跑一轮：提交摘要后立刻能被同一 runtime 检索到（store→updater→search 装配正确）', async () => {
    const rt = runtime();
    const report = await rt.runOnce();
    expect(report).toMatchObject({ topicsChecked: 1, topicsUpdated: 1, topicsFailed: 0 });

    const result = await rt.search({ query: 'owner' }, { visibleChatIds: ['oc_1'] });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].topicKey).toBe('thread:oc_1:om_1');
    expect(result.items[0].matches[0].text).toContain('owner');
  });

  it('第二轮没有新消息时零模型调用（不重复花钱）', async () => {
    const enrich = vi.fn(enricher.enrich);
    const rt = runtime({
      source: {
        discoverTopics: async () => [entry],
        // 第二轮源侧仍然返回同一条消息（尾部窗口的常态）：必须靠游标判成「无增量」。
        readMessages: async () => ({ messages: [message('om_1', 1, '讨论跨 bot owner 校验')], truncated: false }),
      },
      resolveEnricher: () => ({ generatorKey: 'test-model@v1', enrich }),
    });
    await rt.runOnce();
    expect(enrich).toHaveBeenCalledTimes(1);
    const second = await rt.runOnce();
    expect(second.topicsUpdated).toBe(0);
    expect(second.topicsSkipped).toBe(1);
    expect(enrich).toHaveBeenCalledTimes(1);
  });

  it('授权群之外的话题不进入本轮（按 allowedChatIds 过滤）', async () => {
    const otherEntry = { ...entry, chatId: 'oc_other', rootMessageId: 'om_9' };
    const rt = runtime({ source: source([message('om_1', 1, 'x')], [otherEntry]) });
    const report = await rt.runOnce();
    expect(report.topicsChecked).toBe(0);
    expect(store.listTopics()).toHaveLength(0);
  });

  it('停用不截断已接纳批次：并发 2、批次 3，队列中的第 3 个也正常提交', async () => {
    const entries = [
      { ...entry, rootMessageId: 'om_1' },
      { ...entry, rootMessageId: 'om_2' },
      { ...entry, rootMessageId: 'om_3' },
    ];
    let enabled = true;
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const readMessages = vi.fn(async (target: { rootMessageId: string }) => ({
      messages: [{
        messageId: `msg_${target.rootMessageId}`,
        createTime: '2026-10-01T00:00:01.000Z',
        text: `讨论 ${target.rootMessageId}`,
      }],
      truncated: false,
      verifiedThread: true,
    }));
    const enrich = vi.fn(async (request: { newMessages: Array<{ messageId: string }> }) => {
      started += 1;
      if (started === 2) {
        // 前两个已进入模型调用，此时管理员关闭功能。
        enabled = false;
        release();
      }
      await gate;
      return {
        mutations: request.newMessages.map(message => ({
          op: 'add' as const,
          text: '摘要',
          keywords: [],
          sourceMessageIds: [message.messageId],
        })),
        generatorKey: 'test-model@v1',
      };
    });
    const rt = runtime({
      readConfig: () => ({
        enabled,
        allowedChatIds: ['oc_1'],
        llmModelRef: 'topic-enricher',
        maxTopicsPerRun: 3,
        maxConcurrentTopics: 2,
      }),
      source: { discoverTopics: async () => entries, readMessages } as never,
      resolveEnricher: () => ({ generatorKey: 'test-model@v1', enrich }),
      now: () => '2026-10-01T00:00:00.000Z',
    });

    const report = await rt.runOnce();
    expect(enrich).toHaveBeenCalledTimes(3);
    expect(report.topicsUpdated).toBe(3);
    for (const target of ['om_1', 'om_2', 'om_3']) {
      expect(store.getTopic(`thread:oc_1:${target}`)!.summaries).toHaveLength(1);
    }

    // 下一轮：拒绝接纳新批次，不再读源/调模型。
    const readsBefore = readMessages.mock.calls.length;
    await expect(rt.runOnce()).rejects.toMatchObject({ code: 'disabled' });
    expect(readMessages.mock.calls.length).toBe(readsBefore);
    expect(enrich).toHaveBeenCalledTimes(3);
  });

  it('群移出更新范围后，已保留的历史话题仍可检索', async () => {
    const first = runtime();
    await first.runOnce();
    expect(store.getTopic('thread:oc_1:om_1')!.summaries).toHaveLength(1);

    // 只把 oc_1 从更新范围移出：后续不再扫描它，但历史摘要不能被删除或隐藏。
    const second = runtime({
      readConfig: () => ({
        enabled: true,
        allowedChatIds: ['oc_2'],
        llmModelRef: 'topic-enricher',
      }),
    });
    const report = await second.runOnce();
    expect(report.topicsChecked).toBe(0);
    expect(store.getTopic('thread:oc_1:om_1')!.summaries).toHaveLength(1);
    const result = await second.search({ query: 'owner' }, {});
    expect(result.items.map(item => item.topicKey)).toEqual(['thread:oc_1:om_1']);
  });

  it('退避中的失败话题不占预算，失败尝试也参与公平轮转', async () => {
    const entries = [
      { ...entry, rootMessageId: 'om_1' },
      { ...entry, rootMessageId: 'om_2' },
      { ...entry, rootMessageId: 'om_3' },
    ];
    let clock = '2026-10-01T00:00:00.000Z';
    const readMessages = vi.fn(async (target: { rootMessageId: string }) => {
      if (target.rootMessageId === 'om_1') throw new Error('source down');
      return {
        messages: [{
          messageId: `msg_${target.rootMessageId}`,
          createTime: '2026-10-01T00:00:01.000Z',
          text: `讨论 ${target.rootMessageId}`,
        }],
        truncated: false,
        verifiedThread: true,
      };
    });
    const enrich = vi.fn(async (request: { topicTitle: string; newMessages: Array<{ messageId: string }> }) => ({
      mutations: request.newMessages.map(message => ({
        op: 'add' as const,
        text: request.topicTitle,
        keywords: [],
        sourceMessageIds: [message.messageId],
      })),
      generatorKey: 'test-model@v1',
    }));
    const rt = runtime({
      readConfig: () => ({
        enabled: true,
        allowedChatIds: ['oc_1'],
        llmModelRef: 'topic-enricher',
        maxTopicsPerRun: 1,
      }),
      source: { discoverTopics: async () => entries, readMessages } as never,
      resolveEnricher: () => ({ generatorKey: 'test-model@v1', enrich }),
      now: () => clock,
    });

    const first = await rt.runOnce();
    expect(first.topicsFailed).toBe(1);

    clock = '2026-10-02T00:00:00.000Z';
    const second = await rt.runOnce();
    expect(second.topicsUpdated).toBe(1);

    clock = '2026-10-03T00:00:00.000Z';
    const third = await rt.runOnce();
    expect(third.topicsUpdated).toBe(1);

    // 三天里正常话题都推进过一次，而不是队首失败项独占预算。
    expect(store.getTopic('thread:oc_1:om_2')!.summaries).toHaveLength(1);
    expect(store.getTopic('thread:oc_1:om_3')!.summaries).toHaveLength(1);
  });

  it('退避窗口内的失败项不参与本轮预算，预算留给可处理话题', async () => {
    const failing = { ...entry, rootMessageId: 'om_fail' };
    const healthy = { ...entry, rootMessageId: 'om_healthy' };
    const keyOf = (target: { chatId: string; rootMessageId: string }) =>
      `thread:${target.chatId}:${target.rootMessageId}`;

    // 失败项：09:00:00 尝试失败，退避到 09:01:00。
    store.upsertTopicDirectory({
      topicKey: keyOf(failing),
      chatId: failing.chatId,
      rootMessageId: failing.rootMessageId,
      title: failing.title,
      accessPolicyRef: failing.accessPolicyRef,
      now: '2026-10-01T09:00:00.000Z',
    });
    store.recordJobFailure({
      topicKey: keyOf(failing),
      errorCode: 'source_read_failed',
      nextAttemptAt: '2026-10-01T09:01:00.000Z',
      now: '2026-10-01T09:00:00.000Z',
    });
    // 健康项：09:00:10 刚被检查过，按 lastTouched 会排在失败项之后。
    store.upsertTopicDirectory({
      topicKey: keyOf(healthy),
      chatId: healthy.chatId,
      rootMessageId: healthy.rootMessageId,
      title: healthy.title,
      accessPolicyRef: healthy.accessPolicyRef,
      now: '2026-10-01T09:00:10.000Z',
    });
    store.recordCheck({ topicKey: keyOf(healthy), checkedAt: '2026-10-01T09:00:10.000Z' });

    const reads: string[] = [];
    const readMessages = vi.fn(async (target: { rootMessageId: string }) => {
      reads.push(target.rootMessageId);
      return {
        messages: [{
          messageId: `msg_${target.rootMessageId}`,
          createTime: '2026-10-01T09:00:15.000Z',
          text: '新消息',
        }],
        truncated: false,
        verifiedThread: true,
      };
    });
    const rt = runtime({
      readConfig: () => ({
        enabled: true,
        allowedChatIds: ['oc_1'],
        llmModelRef: 'topic-enricher',
        maxTopicsPerRun: 1,
      }),
      source: { discoverTopics: async () => [failing, healthy], readMessages } as never,
      resolveEnricher: () => ({
        generatorKey: 'test-model@v1',
        enrich: async request => ({
          mutations: request.newMessages.map(message => ({
            op: 'add' as const,
            text: '新消息',
            keywords: [],
            sourceMessageIds: [message.messageId],
          })),
          generatorKey: 'test-model@v1',
        }),
      }),
      now: () => '2026-10-01T09:00:20.000Z',
    });

    const report = await rt.runOnce();
    // 退避中的失败项不占预算：这一轮读的是健康话题，而不是撞一次 skipped。
    expect(reads).toEqual(['om_healthy']);
    expect(report.topicsChecked).toBe(1);
    expect(report.topicsSkipped).toBe(0);
    expect(store.getTopic(keyOf(healthy))!.lastCheckedAt).toBe('2026-10-01T09:00:20.000Z');
  });

  it('停用期间在途任务正常提交，恢复后从成功游标增量续跑', async () => {
    let enabled = true;
    let clock = '2026-10-01T00:00:00.000Z';
    const messages: TopicSourceMessage[] = [message('om_1', 1, '第一轮消息')];
    const readMessages = vi.fn(async () => ({
      messages: [...messages],
      truncated: false,
      verifiedThread: true,
    }));
    const enrichCalls: string[][] = [];
    const enrich = vi.fn(async (request: { newMessages: Array<{ messageId: string; text: string }> }) => {
      enrichCalls.push(request.newMessages.map(message => message.messageId));
      // 模型调用进行中，管理员关闭了功能。
      enabled = false;
      return {
        mutations: request.newMessages.map(message => ({
          op: 'add' as const,
          text: message.text,
          keywords: [],
          sourceMessageIds: [message.messageId],
        })),
        generatorKey: 'test-model@v1',
      };
    });
    const rt = runtime({
      readConfig: () => ({ enabled, allowedChatIds: ['oc_1'], llmModelRef: 'topic-enricher' }),
      source: { discoverTopics: async () => [entry], readMessages } as never,
      resolveEnricher: () => ({ generatorKey: 'test-model@v1', enrich }),
      now: () => clock,
    });

    const first = await rt.runOnce();
    // 关闭不丢弃在途结果：摘要照常入库、游标照常推进。
    expect(first.topicsUpdated).toBe(1);
    const afterFirst = store.getTopic('thread:oc_1:om_1')!;
    expect(afterFirst.summaries).toHaveLength(1);
    const cursorAfterFirst = afterFirst.summarizedThroughCursor;
    expect(cursorAfterFirst).toBeTruthy();

    // 关闭后不再发起新任务（不读源、不调模型）。
    const readsBefore = readMessages.mock.calls.length;
    await expect(rt.runOnce()).rejects.toMatchObject({ code: 'disabled' });
    expect(readMessages.mock.calls.length).toBe(readsBefore);

    // 停用期间新增消息；重新开启后只处理游标之后的增量。
    messages.push(message('om_2', 2, '停用期间新增'));
    clock = '2026-10-03T00:00:00.000Z';
    enabled = true;
    const second = await rt.runOnce();
    expect(second.topicsUpdated).toBe(1);
    expect(enrichCalls[1]).toEqual(['om_2']);
    const afterSecond = store.getTopic('thread:oc_1:om_1')!;
    expect(afterSecond.summaries.map(summary => summary.text)).toEqual(['第一轮消息', '停用期间新增']);
    expect(afterSecond.summarizedThroughCursor).not.toBe(cursorAfterFirst);
  });

  it('maxTopicsPerRun 截断时标记 truncated（下轮继续，不一次跑爆）', async () => {
    const entries = [
      entry,
      { ...entry, rootMessageId: 'om_2' },
      { ...entry, rootMessageId: 'om_3' },
    ];
    const rt = runtime({
      readConfig: () => ({ enabled: true, allowedChatIds: ['oc_1'], llmModelRef: 'm', maxTopicsPerRun: 2 }),
      source: source([message('om_1', 1, 'x')], entries),
    });
    const report = await rt.runOnce();
    expect(report.topicsChecked).toBe(2);
    expect(report.truncated).toBe(true);
  });
});
