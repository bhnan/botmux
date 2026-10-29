/** 源消息归一化与增量切分（spec §5.1/§5.2）：
 *  - 去重保序；游标=最后处理消息 id；批界固定，批上限外的留待下轮
 *  - 首轮回看窗口按时间下界裁剪，不宣称覆盖更早内容
 *  - 同毫秒消息不因时间戳被丢弃
 *  - 游标滑出可见窗口：有时间证明则整窗处理，无证明显式 skip（不静默重复/停更）
 *  - 删除核对只对非截断窗口生效
 */
import { describe, it, expect } from 'vitest';
import {
  dedupeSourceMessages,
  decodeSourceCursor,
  encodeSourceCursor,
  findVanishedSourceRefs,
  sliceIncrement,
  type SourceMessage,
} from '../src/topic/source.js';

function msg(messageId: string, atMs: number, text = `t-${messageId}`): SourceMessage {
  return { messageId, senderType: 'user', createTimeMs: atMs, text };
}

// 2026-10-29 前后的一周
const DAY = 24 * 60 * 60_000;
const BASE = Date.parse('2026-10-29T00:00:00Z');

describe('cursor 编解码', () => {
  it('round-trip；非 msg: 前缀返回空', () => {
    expect(decodeSourceCursor(encodeSourceCursor('om_9'))).toBe('om_9');
    expect(decodeSourceCursor(undefined)).toBe('');
    expect(decodeSourceCursor('garbage')).toBe('');
    expect(decodeSourceCursor('msg:')).toBe('');
  });
});

describe('dedupeSourceMessages', () => {
  it('按 id 去重保首次出现与原顺序', () => {
    const out = dedupeSourceMessages([msg('om_1', 1), msg('om_2', 2), msg('om_1', 1), msg('om_3', 3), msg('om_2', 2)]);
    expect(out.map(m => m.messageId)).toEqual(['om_1', 'om_2', 'om_3']);
  });
});

describe('sliceIncrement', () => {
  const window = [msg('om_1', BASE), msg('om_2', BASE + 1_000), msg('om_3', BASE + 2_000), msg('om_4', BASE + 3_000)];

  it('游标在中间：取其后全部，批界=本批最后一条', () => {
    const r = sliceIncrement(window, { cursor: encodeSourceCursor('om_2'), maxBatchMessages: 100 });
    expect(r.hasIncrement).toBe(true);
    expect(r.batch.map(m => m.messageId)).toEqual(['om_3', 'om_4']);
    expect(r.batchEndCursor).toBe(encodeSourceCursor('om_4'));
    expect(r.batchCoverageStartAt).toBe(new Date(BASE + 2_000).toISOString());
  });

  it('游标=最后一条：无增量', () => {
    const r = sliceIncrement(window, { cursor: encodeSourceCursor('om_4'), maxBatchMessages: 100 });
    expect(r.hasIncrement).toBe(false);
    expect(r.batch).toEqual([]);
  });

  it('批上限截断：本批固定上界，余量留下轮', () => {
    const r = sliceIncrement(window, { cursor: encodeSourceCursor('om_1'), maxBatchMessages: 2 });
    expect(r.batch.map(m => m.messageId)).toEqual(['om_2', 'om_3']);
    expect(r.batchEndCursor).toBe(encodeSourceCursor('om_3'));
  });

  it('首轮回看：时间下界之前的消息跳过（不进增量）', () => {
    const r = sliceIncrement(window, { firstRunSinceMs: BASE + 1_500, maxBatchMessages: 100 });
    expect(r.batch.map(m => m.messageId)).toEqual(['om_3', 'om_4']);
  });

  it('同毫秒消息不因时间戳丢弃', () => {
    const same = [msg('om_a', BASE + 5_000), msg('om_b', BASE + 5_000), msg('om_c', BASE + 5_000)];
    const r = sliceIncrement(same, { cursor: encodeSourceCursor('om_a'), maxBatchMessages: 10 });
    expect(r.batch.map(m => m.messageId)).toEqual(['om_b', 'om_c']);
  });

  it('游标消息已滑出窗口：有 sourceThroughAt 时间证明则整窗为新增量', () => {
    const newer = [msg('om_90', BASE + 10 * DAY), msg('om_91', BASE + 10 * DAY + 1)];
    const r = sliceIncrement(newer, {
      cursor: encodeSourceCursor('om_2'), // 已不在窗口内
      maxBatchMessages: 100,
      sourceThroughAtMs: BASE + 3_000,    // 上次处理到的输入时间
    });
    expect(r.hasIncrement).toBe(true);
    expect(r.batch.map(m => m.messageId)).toEqual(['om_90', 'om_91']);
  });

  it('游标滑出窗口且无时间证明：显式 skip 而非静默重复或永久停更', () => {
    const newer = [msg('om_90', BASE + 10 * DAY)];
    const noProof = sliceIncrement(newer, { cursor: encodeSourceCursor('om_2'), maxBatchMessages: 100 });
    expect(noProof).toMatchObject({ hasIncrement: false, skippedReason: 'cursor_beyond_window' });
    const conflicting = sliceIncrement(newer, { cursor: encodeSourceCursor('om_2'), maxBatchMessages: 100, sourceThroughAtMs: BASE + 20 * DAY });
    expect(conflicting).toMatchObject({ hasIncrement: false, skippedReason: 'cursor_beyond_window' });
  });
});

describe('findVanishedSourceRefs（删除核对）', () => {
  it('完整窗口报告消失的引用；截断窗口一律不报告', () => {
    const window = { messages: [msg('om_1', 1), msg('om_2', 2)], truncated: false };
    expect(findVanishedSourceRefs(window, ['om_1', 'om_9', 'om_2'])).toEqual(['om_9']);
    const truncated = { messages: [msg('om_2', 2)], truncated: true };
    // om_1 只是在窗口外，不得误报为已删除
    expect(findVanishedSourceRefs(truncated, ['om_1', 'om_2'])).toEqual([]);
  });
});
