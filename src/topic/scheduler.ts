/**
 * 定时槽位与调度。
 *
 * 设计取舍（与仓库现有 `core/scheduler.ts` 的差别，写清楚免得被当成遗漏）：
 * - 现有调度器是「每 30s 轮询 + 任务自带 nextRunAt」；这里复用同样的驱动形状，但把
 *   「下一次该跑的时刻」**持久化**在 Topic 库里，因为本功能需要跨重启/跨进程语义：
 *   宿主重启后不能因为「忘了上次算到哪」而每天重跑全量，也不能漏掉当天应该做的那一次。
 * - **槽位幂等**：`slotId` 由「本次计划时刻」决定（不是随机 runId），同一时刻只有一次
 *   提交；崩溃后租约到期可被接管（store 侧的 `taken_over`）。
 * - **错过合并**：无论错过几个周期，恢复后只补一次增量（不补发成百上千个任务），
 *   随后把计划时刻推进到「现在之后的第一次」。
 */

import { Cron } from 'croner';

import type { ResolvedTopicSearchConfig, TopicSearchSchedule } from './config.js';
import type { TopicStore } from './store.js';

export const TOPIC_SCHEDULER_TICK_MS = 60_000;
export const TOPIC_SCHEDULER_FIRST_TICK_MS = 5_000;
export const TOPIC_SLOT_LEASE_MS = 15 * 60_000;

export interface TopicRunReport {
  /** 本轮实际检查的话题数。 */
  topicsChecked: number;
  /** 有新消息并提交成功的话题数。 */
  topicsUpdated: number;
  /** 无增量（零模型调用）的话题数。 */
  topicsSkipped: number;
  /** 失败话题数（游标未推进）。 */
  topicsFailed: number;
  /** 生成成功但等待向量的摘要数。 */
  pendingEmbeddings: number;
  /** 是否被 `maxTopicsPerRun` 截断（下轮继续）。 */
  truncated: boolean;
}

export interface TopicSchedulerDeps {
  store: TopicStore;
  resolveConfig: () => ResolvedTopicSearchConfig;
  runOnce: (slotId: string) => Promise<TopicRunReport>;
  now?: () => Date;
  /** 每轮 owner 标识（进程级唯一），用于槽位租约归属。 */
  owner?: string;
  setIntervalImpl?: typeof setInterval;
  setTimeoutImpl?: typeof setTimeout;
  clearIntervalImpl?: typeof clearInterval;
  clearTimeoutImpl?: typeof clearTimeout;
  onReport?: (report: TopicRunReport, slotId: string) => void;
  onError?: (error: unknown, slotId: string) => void;
}

export type TopicTickOutcome =
  | { status: 'disabled' }
  | { status: 'initialized'; nextRunAt: string }
  | { status: 'not_due'; nextRunAt: string }
  | { status: 'skipped'; reason: 'already_finished' | 'lease_held'; nextRunAt: string }
  | { status: 'ran'; report: TopicRunReport; nextRunAt: string }
  | { status: 'failed'; errorCode: string; nextRunAt: string };

/** 计划时刻的计算：cron 用 croner 按时区算，interval 直接加分钟。 */
export function computeNextRunAt(schedule: TopicSearchSchedule, from: Date): Date {
  if (schedule.kind === 'interval') {
    return new Date(from.getTime() + schedule.intervalMinutes * 60_000);
  }
  const job = new Cron(schedule.expression, { timezone: schedule.timeZone });
  const next = job.nextRun(from);
  if (!next) throw new Error('cron expression produced no next run');
  return next;
}

/** 槽位 id：由「计划时刻 + 时区 + 表达式」决定，重启后同一时刻仍是同一槽位。 */
export function computeSlotId(schedule: TopicSearchSchedule, scheduledAtIso: string): string {
  const scheduleKey =
    schedule.kind === 'interval'
      ? `interval:${schedule.intervalMinutes}`
      : `cron:${schedule.expression}@${schedule.timeZone}`;
  return `slot:${scheduleKey}:${scheduledAtIso}`;
}

function createOwnerId(): string {
  return `topic-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface TopicScheduler {
  start(): void;
  stop(): void;
  /** 手动触发一次（测试与 `botmux topic run` 用）。 */
  tick(at?: Date): Promise<TopicTickOutcome>;
}

export function createTopicScheduler(deps: TopicSchedulerDeps): TopicScheduler {
  const now = deps.now ?? (() => new Date());
  const owner = deps.owner ?? createOwnerId();
  const setIntervalImpl = deps.setIntervalImpl ?? setInterval;
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
  const clearIntervalImpl = deps.clearIntervalImpl ?? clearInterval;
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? clearTimeout;
  let intervalTimer: ReturnType<typeof setInterval> | undefined;
  let firstTimer: ReturnType<typeof setTimeout> | undefined;
  let ticking = false;

  async function tick(at: Date = now()): Promise<TopicTickOutcome> {
    const config = deps.resolveConfig();
    if (!config.enabled) return { status: 'disabled' };

    const scheduledAt = deps.store.getNextRunAt();
    if (!scheduledAt) {
      // 首次启动不立刻花模型钱：只把「下一次」落盘，等真正到点再跑。
      const nextRunAt = computeNextRunAt(config.schedule, at).toISOString();
      deps.store.setNextRunAt(nextRunAt, at.toISOString());
      return { status: 'initialized', nextRunAt };
    }
    if (Date.parse(scheduledAt) > at.getTime()) {
      return { status: 'not_due', nextRunAt: scheduledAt };
    }

    const slotId = computeSlotId(config.schedule, scheduledAt);
    const acquired = deps.store.acquireSlot({
      slotId,
      owner,
      now: at.toISOString(),
      leaseMs: TOPIC_SLOT_LEASE_MS,
    });
    if (!acquired.acquired) {
      // 别的进程/实例正在跑同一个槽位：不要抢，也不要因为等它而卡住计划时刻。
      const nextRunAt = computeNextRunAt(config.schedule, at).toISOString();
      deps.store.setNextRunAt(nextRunAt, at.toISOString());
      return { status: 'skipped', reason: acquired.reason, nextRunAt };
    }

    try {
      const report = await deps.runOnce(slotId);
      deps.store.finishSlot({ slotId, owner, status: 'ok', now: now().toISOString() });
      const nextRunAt = computeNextRunAt(config.schedule, at).toISOString();
      deps.store.setNextRunAt(nextRunAt, now().toISOString());
      deps.onReport?.(report, slotId);
      return { status: 'ran', report, nextRunAt };
    } catch (error) {
      const errorCode = (error as { code?: string } | null)?.code ?? 'run_failed';
      deps.store.finishSlot({
        slotId,
        owner,
        status: 'error',
        errorCode,
        now: now().toISOString(),
      });
      // 失败也推进计划时刻：失败重试属于话题级 job 退避，不能在这里热循环。
      const nextRunAt = computeNextRunAt(config.schedule, at).toISOString();
      deps.store.setNextRunAt(nextRunAt, now().toISOString());
      deps.onError?.(error, slotId);
      return { status: 'failed', errorCode, nextRunAt };
    }
  }

  async function safeTick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      await tick();
    } catch {
      // tick 自身不该抛：配置解析/落盘异常留给下一轮，别把定时器打死。
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (intervalTimer) return;
      firstTimer = setTimeoutImpl(() => {
        void safeTick();
      }, TOPIC_SCHEDULER_FIRST_TICK_MS);
      firstTimer.unref?.();
      intervalTimer = setIntervalImpl(() => {
        void safeTick();
      }, TOPIC_SCHEDULER_TICK_MS);
      intervalTimer.unref?.();
    },
    stop() {
      if (firstTimer) {
        clearTimeoutImpl(firstTimer);
        firstTimer = undefined;
      }
      if (intervalTimer) {
        clearIntervalImpl(intervalTimer);
        intervalTimer = undefined;
      }
    },
    tick,
  };
}
