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

    const result = await rt.search({ query: 'owner' }, { allowedChatIds: ['oc_1'] });
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
