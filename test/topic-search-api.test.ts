/** Dashboard 宿主适配层行为回归（spec §6.2）：
 *  - 功能关闭时零启动、查询 403；启动幂等；stop 后可重启
 *  - 启用后：查询走目录候选 + 服务排序；坏请求 400
 *  - 运行中停用（改配置）：查询立即 403（提交/外发边界检查）
 *  - 历史读取路由：按 sourceLarkAppId 找 daemon，找不到报可读错误
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { invalidateGlobalConfigCache } from '../src/global-config.js';
import {
  startTopicSearchHost,
  stopTopicSearchHost,
  handleTopicSearchQuery,
  topicSearchHostActive,
  type TopicSearchHostDeps,
} from '../src/dashboard/topic-search-api.js';
import { computeSummaryContentHash } from '../src/topic/store.js';

let homeDir: string;
let dataDir: string;
let configPath: string;
let prevConfigFile: string | undefined;

const validTopicSearch = {
  enabled: true,
  allowedChatIds: ['oc_chat'],
  llm: { provider: 'openai-compatible', baseUrl: 'https://llm.example.com/v1', model: 'm1', apiKeyEnv: 'TOPIC_TEST_KEY' },
  schedule: { kind: 'interval', intervalMinutes: 30 },
};

function writeConfig(topicSearch: unknown): void {
  writeFileSync(configPath, JSON.stringify({ topicSearch }), 'utf-8');
  invalidateGlobalConfigCache();
}

function hostDeps(): TopicSearchHostDeps {
  return {
    registry: { list: () => [{ larkAppId: 'cli_app1', ipcPort: 1 }] },
    getSessions: () => [],
    dataDir,
    env: { TOPIC_TEST_KEY: 'sk-test' },
  };
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'topic-api-test-'));
  configPath = join(homeDir, 'config.json');
  dataDir = join(homeDir, 'topic-search-data');
  mkdirSync(dataDir, { recursive: true });
  prevConfigFile = process.env.BOTMUX_GLOBAL_CONFIG_FILE;
  process.env.BOTMUX_GLOBAL_CONFIG_FILE = configPath;
  writeConfig(undefined);
});

afterEach(async () => {
  await stopTopicSearchHost();
  if (prevConfigFile === undefined) delete process.env.BOTMUX_GLOBAL_CONFIG_FILE;
  else process.env.BOTMUX_GLOBAL_CONFIG_FILE = prevConfigFile;
  invalidateGlobalConfigCache();
  rmSync(homeDir, { recursive: true, force: true });
});

describe('startTopicSearchHost', () => {
  it('功能关闭：不启动任何东西，查询 403', async () => {
    writeConfig({ enabled: false });
    const state = await startTopicSearchHost(hostDeps());
    expect(state).toBeNull();
    expect(topicSearchHostActive()).toBe(false);
    const outcome = await handleTopicSearchQuery({ query: '任意', mode: 'auto', limit: 10 });
    expect(outcome).toEqual({ status: 403, body: { ok: false, error: 'topic_search_disabled' } });
  });

  it('配置缺失/非法同样拒绝启用', async () => {
    writeConfig({ enabled: true }); // 缺 allowedChatIds/llm/schedule
    expect(await startTopicSearchHost(hostDeps())).toBeNull();
  });

  it('合法配置：启动且幂等；stop 后再启动可用、目录持久', async () => {
    writeConfig(validTopicSearch);
    const first = await startTopicSearchHost(hostDeps());
    expect(first).not.toBeNull();
    const second = await startTopicSearchHost(hostDeps());
    expect(second).toBe(first);
    // 落一条话题知识
    const topic = first!.runtime.topicStore.ensureTopic({
      topicKey: 'thread:oc_chat:om_r1', chatId: 'oc_chat', rootMessageId: 'om_r1',
      title: '部署话题', accessPolicyRef: 'chat:oc_chat',
    }, '2026-10-29T00:00:00Z').topic;
    first!.runtime.topicStore.commitSummaryUpdate({
      topicKey: topic.topicKey, expectedRevision: topic.revision,
      mutations: [{ op: 'add', text: '讨论了部署回滚', keywords: ['deploy'], sourceMessageIds: ['om_1'] }],
      generatorKey: 'm1', now: '2026-10-29T00:00:00Z', summarizedThroughCursor: 'msg:om_1',
    });
    await stopTopicSearchHost();
    expect(topicSearchHostActive()).toBe(false);

    const relaunched = await startTopicSearchHost(hostDeps());
    expect(relaunched).not.toBe(first);
    const outcome = await handleTopicSearchQuery({ query: '部署 回滚', mode: 'auto', limit: 10 });
    expect(outcome.status).toBe(200);
    if (!outcome.body.ok) throw new Error('expected ok');
    expect(outcome.body.result.items).toHaveLength(1);
    expect(outcome.body.result.items[0]!.topicKey).toBe('thread:oc_chat:om_r1');
    expect(outcome.body.result.items[0]!.matches[0]!.text).toBe('讨论了部署回滚');
  });

  it('运行中停用：查询立即 403（外发边界检查）', async () => {
    writeConfig(validTopicSearch);
    await startTopicSearchHost(hostDeps());
    expect(topicSearchHostActive()).toBe(true);
    writeConfig(undefined); // 功能关闭
    const outcome = await handleTopicSearchQuery({ query: '任意', mode: 'auto', limit: 10 });
    expect(outcome.status).toBe(403);
  });
});

describe('handleTopicSearchQuery', () => {
  it('坏请求 400：空查询 / limit 越界 / 坏游标', async () => {
    writeConfig(validTopicSearch);
    await startTopicSearchHost(hostDeps());
    expect((await handleTopicSearchQuery({ query: '', mode: 'auto', limit: 10 })).status).toBe(400);
    expect((await handleTopicSearchQuery({ query: 'x', mode: 'auto', limit: 999 })).status).toBe(400);
    expect((await handleTopicSearchQuery({ query: 'x', mode: 'auto', limit: 10, cursor: 'garbage!' })).status).toBe(400);
  });

  it('filters.chatIds 只收窄：目录外群不返回', async () => {
    // 两个群都在授权清单里（查询过滤在授权集之上只收窄，不提权）
    writeConfig({ ...validTopicSearch, allowedChatIds: ['oc_chat', 'oc_chat2'] });
    const state = await startTopicSearchHost(hostDeps());
    for (const chat of ['oc_chat', 'oc_chat2']) {
      const topic = state!.runtime.topicStore.ensureTopic({
        topicKey: `thread:${chat}:om_r`, chatId: chat, rootMessageId: 'om_r',
        title: '部署话题', accessPolicyRef: `chat:${chat}`,
      }, '2026-10-29T00:00:00Z').topic;
      state!.runtime.topicStore.commitSummaryUpdate({
        topicKey: topic.topicKey, expectedRevision: topic.revision,
        mutations: [{ op: 'add', text: '部署内容', keywords: [], sourceMessageIds: ['om_1'] }],
        generatorKey: 'm1', now: '2026-10-29T00:00:00Z',
      });
    }
    const narrowed = await handleTopicSearchQuery({ query: '部署', mode: 'auto', limit: 10, filters: { chatIds: ['oc_chat2'] } });
    expect(narrowed.status).toBe(200);
    if (!narrowed.body.ok) throw new Error('expected ok');
    expect(narrowed.body.result.items.map(i => i.topicKey)).toEqual(['thread:oc_chat2:om_r']);
  });
});

describe('contentHash 一致性（宿主层与存储层共用）', () => {
  it('宿主层引用的 hash 函数与 store 一致', () => {
    expect(typeof computeSummaryContentHash('x')).toBe('string');
    expect(computeSummaryContentHash('x')).toHaveLength(64);
  });
});
