import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openTopicStore, type TopicStore } from '../src/topic/store.js';
import { computeNextRunAt, computeSlotId, createTopicScheduler, type TopicRunReport } from '../src/topic/scheduler.js';
import type { ResolvedTopicSearchConfig } from '../src/topic/config.js';
import { TOPIC_SEARCH_DEFAULT_CONFIG } from '../src/topic/config.js';

const config: ResolvedTopicSearchConfig = {
  ...TOPIC_SEARCH_DEFAULT_CONFIG,
  enabled: true,
  allowedChatIds: ['oc_1'],
  llmModelRef: 'topic-enricher',
};

const emptyReport: TopicRunReport = {
  topicsChecked: 0,
  topicsUpdated: 0,
  topicsSkipped: 0,
  topicsFailed: 0,
  pendingEmbeddings: 0,
  truncated: false,
};

let dir: string;
let store: TopicStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'topic-scheduler-test-'));
  store = openTopicStore({ path: join(dir, 'topics.sqlite') });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function schedulerWith(runOnce: ReturnType<typeof vi.fn>, options: { config?: ResolvedTopicSearchConfig } = {}) {
  return createTopicScheduler({
    store,
    resolveConfig: () => options.config ?? config,
    runOnce: runOnce as never,
    owner: 'test-owner',
    now: () => new Date('2026-10-30T02:00:00.000Z'),
  });
}

describe('计划时刻与槽位', () => {
  it('interval 按分钟推进', () => {
    const next = computeNextRunAt({ kind: 'interval', intervalMinutes: 30 }, new Date('2026-10-30T02:00:00.000Z'));
    expect(next.toISOString()).toBe('2026-10-30T02:30:00.000Z');
  });

  it('cron 按配置时区算（Asia/Shanghai 02:00 = 18:00Z 前一天）', () => {
    const next = computeNextRunAt(
      { kind: 'cron', expression: '0 2 * * *', timeZone: 'Asia/Shanghai' },
      new Date('2026-10-30T10:00:00.000Z'),
    );
    expect(next.toISOString()).toBe('2026-10-30T18:00:00.000Z');
  });

  it('槽位 id 由计划时刻 + 表达式决定，重启后同一时刻仍是同一槽位', () => {
    const at = '2026-10-30T18:00:00.000Z';
    const a = computeSlotId({ kind: 'cron', expression: '0 2 * * *', timeZone: 'Asia/Shanghai' }, at);
    const b = computeSlotId({ kind: 'cron', expression: '0 2 * * *', timeZone: 'Asia/Shanghai' }, at);
    const other = computeSlotId({ kind: 'cron', expression: '0 3 * * *', timeZone: 'Asia/Shanghai' }, at);
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });
});

describe('调度 tick', () => {
  it('首次 tick 只落盘「下一次」，不立即花模型钱', async () => {
    const runOnce = vi.fn(async () => emptyReport);
    const scheduler = schedulerWith(runOnce);
    const outcome = await scheduler.tick(new Date('2026-10-30T02:00:00.000Z'));
    expect(outcome.status).toBe('initialized');
    expect(runOnce).not.toHaveBeenCalled();
    expect(store.getNextRunAt()).toBe('2026-10-30T18:00:00.000Z');
  });

  it('未到点不跑', async () => {
    const runOnce = vi.fn(async () => emptyReport);
    const scheduler = schedulerWith(runOnce);
    await scheduler.tick(new Date('2026-10-30T02:00:00.000Z'));
    const outcome = await scheduler.tick(new Date('2026-10-30T10:00:00.000Z'));
    expect(outcome.status).toBe('not_due');
    expect(runOnce).not.toHaveBeenCalled();
  });

  it('到点跑一次并推进计划时刻；同一槽位第二次 tick 不会重复跑', async () => {
    const runOnce = vi.fn(async () => emptyReport);
    const scheduler = schedulerWith(runOnce);
    await scheduler.tick(new Date('2026-10-30T02:00:00.000Z'));
    const ran = await scheduler.tick(new Date('2026-10-30T18:00:01.000Z'));
    expect(ran.status).toBe('ran');
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(store.getNextRunAt()).toBe('2026-10-31T18:00:00.000Z');

    const again = await scheduler.tick(new Date('2026-10-30T18:02:00.000Z'));
    expect(again.status).toBe('not_due');
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it('错过多个周期只补一次（合并成一次增量），不补发成百上千个任务', async () => {
    const runOnce = vi.fn(async () => emptyReport);
    const scheduler = schedulerWith(runOnce);
    await scheduler.tick(new Date('2026-10-30T02:00:00.000Z'));
    // 十天没跑：仍然只跑一轮。
    const outcome = await scheduler.tick(new Date('2026-11-09T03:00:00.000Z'));
    expect(outcome.status).toBe('ran');
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(store.getNextRunAt()).toBe('2026-11-09T18:00:00.000Z');
  });

  it('别的 owner 持有同槽位租约时不抢，也不阻塞计划推进', async () => {
    store.setNextRunAt('2026-10-30T18:00:00.000Z', '2026-10-30T02:00:00.000Z');
    store.acquireSlot({
      slotId: computeSlotId({ kind: 'cron', expression: '0 2 * * *', timeZone: 'Asia/Shanghai' }, '2026-10-30T18:00:00.000Z'),
      owner: 'someone-else',
      now: '2026-10-30T18:00:00.000Z',
      leaseMs: 15 * 60_000,
    });
    const runOnce = vi.fn(async () => emptyReport);
    const scheduler = schedulerWith(runOnce);
    const outcome = await scheduler.tick(new Date('2026-10-30T18:00:10.000Z'));
    expect(outcome.status).toBe('skipped');
    expect(runOnce).not.toHaveBeenCalled();
    expect(store.getNextRunAt()).toBe('2026-10-31T18:00:00.000Z');
  });

  it('失败时记错误并推进计划时刻（失败重试归话题级退避，不在这里热循环）', async () => {
    const runOnce = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { code: 'run_failed' });
    });
    const scheduler = schedulerWith(runOnce);
    await scheduler.tick(new Date('2026-10-30T02:00:00.000Z'));
    const outcome = await scheduler.tick(new Date('2026-10-30T18:00:01.000Z'));
    expect(outcome.status).toBe('failed');
    expect(store.getNextRunAt()).toBe('2026-10-31T18:00:00.000Z');
  });

  it('功能关闭时 tick 直接 disabled，不碰库', async () => {
    const runOnce = vi.fn(async () => emptyReport);
    const scheduler = schedulerWith(runOnce, { config: { ...config, enabled: false } });
    expect((await scheduler.tick(new Date('2026-10-30T02:00:00.000Z'))).status).toBe('disabled');
    expect(store.getNextRunAt()).toBeNull();
  });
});
