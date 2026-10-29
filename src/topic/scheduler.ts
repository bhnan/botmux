/** Schedule timing for the topic runtime (spec §4/§5.4).
 *
 * croner owns cron-in-timezone evaluation (already a runtime dependency, same
 * engine as the user scheduler). This module adds:
 * - slot ids: a repeated wall-clock fire during a DST fall-back hour must not
 *   run twice (spec §4: DST 重复时段按槽位 ID 去重). The slot id is the
 *   intended wall-clock time in the configured zone, not the UTC instant.
 * - missed-slot merging: N missed slots ⇒ ONE catch-up run on the next
 *   evaluation; we never replay a backlog (spec §5.4).
 */
import { Cron } from 'croner';
import type { TopicSearchSchedule } from './config.js';

export interface ScheduleSlot {
  /** Wall-clock identity of the slot (dedup key). */
  slotId: string;
  /** When the slot is due (epoch ms). */
  dueAtMs: number;
}

/** Build the croner pattern for the schedule kind. fixed-time "HH:MM" maps to
 * a daily cron at that wall time in the configured zone; interval maps to an
 * every-N-minutes pattern with the 15-minute floor already enforced by config
 * validation. */
function cronPattern(schedule: TopicSearchSchedule): { pattern: string; timeZone?: string } {
  if (schedule.kind === 'cron') return { pattern: schedule.expression!, timeZone: schedule.timeZone };
  if (schedule.kind === 'fixed-time') {
    const [hh, mm] = schedule.time!.split(':');
    return { pattern: `${Number(mm)} ${Number(hh)} * * *`, timeZone: schedule.timeZone };
  }
  return { pattern: `*/${schedule.intervalMinutes!} * * * *` };
}

function cronOptions(timeZone: string | undefined): Record<string, unknown> {
  // croner defaults to the host zone; pass the configured IANA zone through.
  return timeZone ? { timezone: timeZone } : {};
}

/** The next slot strictly after `nowMs`. Returns undefined when the pattern
 * cannot fire again (croner signals via nextRun() === null). */
export function nextSlot(schedule: TopicSearchSchedule, nowMs: number): ScheduleSlot | undefined {
  const { pattern, timeZone } = cronPattern(schedule);
  let cron: Cron;
  try {
    cron = new Cron(pattern, { ...cronOptions(timeZone), paused: true, catch: false });
  } catch {
    return undefined;
  }
  const nextMs = cron.nextRun(new Date(nowMs))?.getTime();
  cron.stop();
  if (nextMs === undefined || !Number.isFinite(nextMs)) return undefined;
  return { slotId: wallClockSlotId(schedule, nextMs), dueAtMs: nextMs };
}

/** Wall-clock identity in the schedule's own zone: two fires resolving to the
 * same zone-local date+time are the same slot even if their UTC instants
 * differ (DST fall-back). Interval schedules fall back to the UTC minute —
 * intervals crossing a DST shift are distinct minutes by construction. */
export function wallClockSlotId(schedule: TopicSearchSchedule, epochMs: number): string {
  if (schedule.kind === 'interval') return `i:${Math.floor(epochMs / 60_000)}`;
  const zone = schedule.timeZone ?? 'UTC';
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = formatter.formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '??';
  return `w:${zone}:${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export interface DueRunDecision {
  due: boolean;
  slotId?: string;
  /** How many slots were skipped since the last run (merged into this one). */
  mergedMissedSlots?: number;
}

/** Decide whether a tick at `nowMs` should run, given the last executed slot
 * id and when the runtime last looked. Missed slots merge: the decision is
 * simply "the next slot after the last look is already due" — one run covers
 * everything missed. With NO last run recorded (fresh enable / restart), the
 * first evaluation is due immediately (bootstrap catch-up, spec §5.4 恢复后
 * 执行一次增量补跑) — its slot id is unique so it never collides with a real
 * scheduled slot. */
export function evaluateDueRun(
  schedule: TopicSearchSchedule,
  args: { nowMs: number; lastSlotId?: string; lastLookMs?: number },
): DueRunDecision {
  if (args.lastLookMs === undefined) {
    return { due: true, slotId: `bootstrap:${args.nowMs}`, mergedMissedSlots: 1 };
  }
  const slot = nextSlot(schedule, args.lastLookMs);
  if (!slot) return { due: false };
  if (slot.dueAtMs > args.nowMs) return { due: false };
  if (slot.slotId === args.lastSlotId) return { due: false };
  // Count how many scheduled slots passed since the last look (capped so a
  // long sleep can't spin here).
  let merged = 1;
  let probe = slot;
  for (let i = 0; i < 512; i++) {
    const next = nextSlot(schedule, probe.dueAtMs);
    if (!next || next.dueAtMs > args.nowMs) break;
    merged++;
    probe = next;
  }
  return { due: true, slotId: slot.slotId, mergedMissedSlots: merged };
}
