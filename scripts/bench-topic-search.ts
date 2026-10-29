/**
 * 话题检索质量/延迟基准（固定合成数据集，可重复运行）。
 *
 * 为什么是合成数据：spec §8 的质量目标要求「20 条真实查询 + 人工确认目标话题」，
 * 真实查询集只能由管理员提供；在拿到之前，这个脚本固定 1,000 话题 / 10,000 摘要，
 * 用 20 条确定性查询测**召回机制与延迟**。它证明「同样的数据规模下检索是否退化」，
 * 不证明语义相关性 —— 报告里必须分开写。
 *
 * 数据集刻意包含：
 * - 每个话题一个唯一实体词（出现在它的全部摘要里），跨话题共享领域短语作为干扰；
 * - 20 个群、每群 50 个话题，检索必须先按授权范围过滤再打分；
 * - 每个话题 10 条摘要，用来验证按 topicKey 去重与 Top-3 归属。
 *
 * 运行：
 *   bun scripts/bench-topic-search.ts
 *   bun scripts/bench-topic-search.ts --out /tmp/topic-search-bench.json
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTopicSearchService } from '../src/topic/search.js';
import { openTopicStore } from '../src/topic/store.js';

const TOPIC_COUNT = 1_000;
const SUMMARIES_PER_TOPIC = 10;
const CHAT_COUNT = 20;
const QUERY_COUNT = 20;
const RUNS_PER_QUERY = 10;

const ENTITY_CHARS = '云杉赤狐青禾白鹭星河山岚潮汐竹影松间月桂南乔东篱西洲北岛清和知远观澜听雨临风映雪含章';
const PHRASES = [
  '跨 bot owner 校验',
  '话题检索与摘要',
  '沙箱只读挂载',
  '定时任务租约',
  '会话恢复流程',
  '权限交接边界',
  '向量召回融合',
  '增量游标推进',
  '飞书话题历史',
  'Dashboard 认证',
  '模型调用预算',
  '失败退避重试',
  '延迟绑定锚点',
  '原生话题 ID',
  '群与话题划分',
  '摘要失效清理',
  'embedding 回填',
  '管理员配置',
  '停用与回滚',
  '命中摘要展示',
] as const;

function entityOf(index: number): string {
  const first = ENTITY_CHARS[index % ENTITY_CHARS.length];
  const second = ENTITY_CHARS[Math.floor(index / ENTITY_CHARS.length) % ENTITY_CHARS.length];
  return `${first}${second}`;
}

function topicOf(index: number): { topicKey: string; chatId: string; rootMessageId: string } {
  const chatId = `oc_group_${index % CHAT_COUNT}`;
  const rootMessageId = `om_topic_${index}`;
  return { topicKey: `thread:${chatId}:${rootMessageId}`, chatId, rootMessageId };
}

function summaryText(topicIndex: number, summaryIndex: number): string {
  const entity = entityOf(topicIndex);
  const first = PHRASES[(topicIndex * 7 + summaryIndex) % PHRASES.length];
  const second = PHRASES[(topicIndex * 3 + summaryIndex * 5) % PHRASES.length];
  return `${entity} 的讨论记录：${first} 与 ${second}，第 ${summaryIndex + 1} 条结论。`;
}

interface Sample {
  query: string;
  targetTopicKey: string;
  latencyMs: number;
  hitAt3: boolean;
  items: number;
  unique: boolean;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out');
  const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
  const dir = mkdtempSync(join(tmpdir(), 'topic-search-bench-'));
  const store = openTopicStore({ path: join(dir, 'topics.sqlite') });
  try {
    const startedSeed = performance.now();
    for (let index = 0; index < TOPIC_COUNT; index += 1) {
      const topic = topicOf(index);
      store.upsertTopicDirectory({
        topicKey: topic.topicKey,
        chatId: topic.chatId,
        rootMessageId: topic.rootMessageId,
        title: `${entityOf(index)} 方案讨论`,
        accessPolicyRef: 'benchmark:topic-search',
        now: '2026-10-29T00:00:00.000Z',
        coverageStartAt: '2026-10-01T00:00:00.000Z',
      });
      store.commitSummaryMutation({
        topicKey: topic.topicKey,
        expectedRevision: 0,
        mutations: Array.from({ length: SUMMARIES_PER_TOPIC }, (_, summaryIndex) => ({
          op: 'add' as const,
          text: summaryText(index, summaryIndex),
          keywords: [entityOf(index), PHRASES[(index + summaryIndex) % PHRASES.length]],
          sourceMessageIds: [`om_msg_${index}_${summaryIndex}`],
        })),
        nextCursor: `cursor_${index}`,
        sourceThroughAt: '2026-10-29T00:00:00.000Z',
        generatorKey: 'benchmark@v1',
        now: '2026-10-29T00:00:00.000Z',
      });
    }
    const seedMs = performance.now() - startedSeed;

    const service = createTopicSearchService({
      store,
      knownTopicCount: () => TOPIC_COUNT,
      maxCandidateTopics: 5_000,
      topicUrl: topic => `https://example.test/topic/${topic.rootMessageId}`,
    });
    const allowedChatIds = Array.from({ length: CHAT_COUNT }, (_, index) => `oc_group_${index}`);
    const caller = { allowedChatIds };

    // Deterministic spread over the corpus (stride keeps targets from clustering).
    const queryIndexes = Array.from({ length: QUERY_COUNT }, (_, index) =>
      (index * 47 + 13) % TOPIC_COUNT);
    const queries = queryIndexes.map(index => ({
      query: `${entityOf(index)} 讨论`,
      targetTopicKey: topicOf(index).topicKey,
    }));

    // Warm-up: the first query pays module/DB caches, not the retrieval itself.
    for (const item of queries.slice(0, 3)) {
      await service.search({ query: item.query }, caller);
    }

    const samples: Sample[] = [];
    for (const item of queries) {
      for (let run = 0; run < RUNS_PER_QUERY; run += 1) {
        const started = performance.now();
        const response = await service.search({ query: item.query, limit: 5 }, caller);
        const latencyMs = performance.now() - started;
        const keys = response.items.map(entry => entry.topicKey);
        samples.push({
          query: item.query,
          targetTopicKey: item.targetTopicKey,
          latencyMs,
          hitAt3: keys.slice(0, 3).includes(item.targetTopicKey),
          items: response.items.length,
          unique: new Set(keys).size === keys.length,
        });
      }
    }

    const latencies = samples.map(sample => sample.latencyMs).sort((a, b) => a - b);
    const top3 = samples.filter(sample => sample.hitAt3).length / samples.length;
    const unique = samples.every(sample => sample.unique);
    const result = {
      generatedAt: new Date().toISOString(),
      dataset: {
        topics: TOPIC_COUNT,
        summaries: TOPIC_COUNT * SUMMARIES_PER_TOPIC,
        chats: CHAT_COUNT,
        summariesPerTopic: SUMMARIES_PER_TOPIC,
        seedMs: Math.round(seedMs),
      },
      queries: {
        count: QUERY_COUNT,
        runsPerQuery: RUNS_PER_QUERY,
        samples: samples.length,
        top3HitRate: Number(top3.toFixed(4)),
        uniqueTopicsPerResult: unique,
      },
      latencyMs: {
        p50: Number(percentile(latencies, 50).toFixed(2)),
        p95: Number(percentile(latencies, 95).toFixed(2)),
        max: Number(Math.max(...latencies).toFixed(2)),
      },
      caveat:
        'Synthetic corpus with unique entity tokens: measures retrieval mechanics and latency, not semantic relevance. Real-query Top-3 needs an admin-provided query set.',
    };
    console.log(JSON.stringify(result, null, 2));
    if (outPath) writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
