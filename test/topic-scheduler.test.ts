/** 调度时序（spec §4/§5.4）：
 *  - cron/fixed-time/interval 三形态经 croner 求下一槽
 *  - DST 回拨重复时段按墙钟槽位 ID 去重（同一本地时刻两次触发 = 同一槽）
 *  - 错过多个槽位合并为一次运行；同槽重复触发不再运行
 */
import { describe, it, expect } from 'vitest';
import { evaluateDueRun, nextSlot, wallClockSlotId, type ScheduleSlot } from '../src/topic/scheduler.js';
import type { TopicSearchSchedule } from '../src/topic/config.js';

const cron: TopicSearchSchedule = { kind: 'cron', expression: '0 2 * * *', timeZone: 'Asia/Shanghai' };
const fixed: TopicSearchSchedule = { kind: 'fixed-time', time: '02:30', timeZone: 'Asia/Shanghai' };
const interval: TopicSearchSchedule = { kind: 'interval', intervalMinutes: 30 };

describe('nextSlot', () => {
  it('cron：上海 02:00 的下一槽换算为 UTC', () => {
    // 2026-10-29T00:00Z = 上海 10-29 08:00；今天 02:00 已过 → 下一槽 = 上海 10-30 02:00 = 10-29T18:00Z
    const slot = nextSlot(cron, Date.parse('2026-10-29T00:00:00Z'));
    expect(slot).toBeDefined();
    expect(new Date(slot!.dueAtMs).toISOString()).toBe('2026-10-29T18:00:00.000Z');
  });

  it('fixed-time 映射为每日 cron；interval 映射为每 N 分钟', () => {
    const slot = nextSlot(fixed, Date.parse('2026-10-29T00:00:00Z'));
    expect(new Date(slot!.dueAtMs).toISOString()).toBe('2026-10-29T18:30:00.000Z');
    const halfHour = nextSlot(interval, Date.parse('2026-10-29T00:00:00Z'));
    expect(new Date(halfHour!.dueAtMs).toISOString()).toBe('2026-10-29T00:30:00.000Z');
  });

  it('非法表达式返回 undefined 而非抛错', () => {
    expect(nextSlot({ kind: 'cron', expression: 'not a cron', timeZone: 'UTC' }, Date.now())).toBeUndefined();
  });

  it('槽位严格晚于当前时刻', () => {
    const at = Date.parse('2026-10-29T17:59:59Z');
    const slot = nextSlot(cron, at);
    expect(slot!.dueAtMs).toBeGreaterThan(at);
  });
});

describe('wallClockSlotId（DST 去重）', () => {
  it('纽约 2026-11-01 回拨：01:30 本地出现两次，两次 UTC 时刻同槽', () => {
    const ny: TopicSearchSchedule = { kind: 'fixed-time', time: '01:30', timeZone: 'America/New_York' };
    // 2026-11-01 05:30Z = EDT 01:30；06:30Z = EST 01:30（回拨后的同一墙钟时间）
    const first = wallClockSlotId(ny, Date.parse('2026-11-01T05:30:00Z'));
    const second = wallClockSlotId(ny, Date.parse('2026-11-01T06:30:00Z'));
    expect(first).toBe(second);
    // 正常推进的两天不同槽
    const day2 = wallClockSlotId(ny, Date.parse('2026-11-02T05:30:00Z'));
    expect(day2).not.toBe(first);
  });

  it('interval 槽位按 UTC 分钟，不跨时区折叠', () => {
    const a = wallClockSlotId(interval, Date.parse('2026-11-01T05:30:00Z'));
    const b = wallClockSlotId(interval, Date.parse('2026-11-01T05:30:59Z'));
    expect(a).toBe(b); // 同一分钟
    const c = wallClockSlotId(interval, Date.parse('2026-11-01T05:31:00Z'));
    expect(c).not.toBe(a);
  });
});

describe('evaluateDueRun', () => {
  it('未到点不运行；到点运行并给出槽位', () => {
    const before = evaluateDueRun(cron, { nowMs: Date.parse('2026-10-28T17:00:00Z'), lastLookMs: Date.parse('2026-10-28T16:00:00Z') });
    expect(before.due).toBe(false);
    const at = evaluateDueRun(cron, { nowMs: Date.parse('2026-10-28T18:00:00Z'), lastLookMs: Date.parse('2026-10-28T17:00:00Z') });
    expect(at.due).toBe(true);
    expect(at.slotId).toBe(wallClockSlotId(cron, Date.parse('2026-10-28T18:00:00Z')));
  });

  it('同一槽位只运行一次（重复评估去重）', () => {
    const slotDue = Date.parse('2026-10-28T18:00:00Z');
    const args = { nowMs: slotDue + 60_000, lastSlotId: wallClockSlotId(cron, slotDue), lastLookMs: slotDue - 60_000 };
    expect(evaluateDueRun(cron, args).due).toBe(false);
  });

  it('错过多个槽位合并为一次运行（不重放积压）', () => {
    // 上次看是 10-25，现在 10-29：中间错过 3 个每日槽，应合并为 1 次
    const decision = evaluateDueRun(cron, {
      nowMs: Date.parse('2026-10-29T00:00:00Z'),
      lastLookMs: Date.parse('2026-10-25T00:00:00Z'),
    });
    expect(decision.due).toBe(true);
    expect(decision.mergedMissedSlots!).toBeGreaterThanOrEqual(3);
  });

  it('无上次记录（首次启用）：立即补跑一次', () => {
    const decision = evaluateDueRun(interval, { nowMs: Date.parse('2026-10-29T00:31:00Z') });
    expect(decision.due).toBe(true);
    expect(decision.slotId).toMatch(/^bootstrap:/);
    expect(decision.mergedMissedSlots).toBe(1);
  });
});

describe('ScheduleSlot 类型守卫（编译期契约）', () => {
  it('slot 携带 slotId 与 dueAtMs', () => {
    const slot: ScheduleSlot | undefined = nextSlot(fixed, Date.now());
    if (slot) {
      expect(typeof slot.slotId).toBe('string');
      expect(typeof slot.dueAtMs).toBe('number');
    }
  });
});
