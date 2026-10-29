import { describe, expect, it, vi } from 'vitest';

import {
  decodeCursor,
  encodeCursor,
  normalizeSourceMessages,
  selectIncrement,
  type TopicSourceMessage,
} from '../src/topic/source.js';
import { createDaemonTopicSource } from '../src/topic/daemon-source.js';

function message(messageId: string, createTime: string, text = 'x'): TopicSourceMessage {
  return { messageId, createTime, text };
}

describe('源消息归一化与游标', () => {
  it('游标编码可往返，脏值返回 null', () => {
    const cursor = { createTime: '2026-10-01T00:00:00.000Z', messageIds: ['om_1', 'om_2'] };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    for (const bad of ['', 'not-base64!!', Buffer.from('{"v":2}').toString('base64url'), null, 42]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });

  it('按 createTime 升序稳定排序，丢掉缺 id/时间的脏项', () => {
    const normalized = normalizeSourceMessages([
      { messageId: 'om_b', createTime: '2026-10-01T00:00:02.000Z', text: 'b' },
      { messageId: 'om_a', createTime: '2026-10-01T00:00:01.000Z', text: 'a' },
      { messageId: '', createTime: '2026-10-01T00:00:03.000Z' },
      { messageId: 'om_c' },
      { message_id: 'om_d', create_time: '2026-10-01T00:00:00.000Z', sender_name: '某人' },
    ]);
    expect(normalized.map(item => item.messageId)).toEqual(['om_d', 'om_a', 'om_b']);
    expect(normalized[0].senderName).toBe('某人');
  });
});

describe('增量切分（同毫秒不能丢消息）', () => {
  it('没有游标时按 limit 取前 N 条，并报告还有剩余', () => {
    const selection = selectIncrement({
      messages: [message('om_1', 't1'), message('om_2', 't2'), message('om_3', 't3')],
      limit: 2,
    });
    expect(selection.batch.map(item => item.messageId)).toEqual(['om_1', 'om_2']);
    expect(selection.truncated).toBe(true);
    expect(selection.nextCursor).toEqual({ createTime: 't2', messageIds: ['om_2'] });
  });

  it('边界毫秒上的新消息会被纳入，已处理的不重复', () => {
    const selection = selectIncrement({
      messages: [
        message('om_1', '2026-10-01T00:00:01.000Z'),
        message('om_2', '2026-10-01T00:00:02.000Z'),
        message('om_3', '2026-10-01T00:00:02.000Z'),
      ],
      cursor: { createTime: '2026-10-01T00:00:02.000Z', messageIds: ['om_2'] },
      limit: 10,
    });
    expect(selection.batch.map(item => item.messageId)).toEqual(['om_3']);
    // 游标要把同一毫秒上已处理的 id 一起带上，否则下一轮 om_2 会被当成新的。
    expect(selection.nextCursor).toEqual({
      createTime: '2026-10-01T00:00:02.000Z',
      messageIds: ['om_2', 'om_3'],
    });
  });

  it('没有新消息时游标保持不变，且不算截断', () => {
    const cursor = { createTime: '2026-10-01T00:00:09.000Z', messageIds: ['om_9'] };
    const selection = selectIncrement({
      messages: [message('om_9', '2026-10-01T00:00:09.000Z'), message('om_5', '2026-10-01T00:00:05.000Z')],
      cursor,
      limit: 10,
    });
    expect(selection.batch).toEqual([]);
    expect(selection.nextCursor).toBe(cursor);
    expect(selection.truncated).toBe(false);
  });

  it('早于游标的消息视为已处理（源侧重复分页兜底）', () => {
    const selection = selectIncrement({
      messages: [message('om_1', '2026-10-01T00:00:01.000Z'), message('om_2', '2026-10-01T00:00:02.000Z')],
      cursor: { createTime: '2026-10-01T00:00:01.000Z', messageIds: ['om_1'] },
      limit: 10,
    });
    expect(selection.batch.map(item => item.messageId)).toEqual(['om_2']);
  });
});

describe('daemon 源：增量契约的完整性判定', () => {
  const sessions = [
    { sessionId: 's1', chatId: 'oc_1', rootMessageId: 'om_1', title: '话题一', larkAppId: 'app_a', lastMessageAt: 10 },
    { sessionId: 's2', chatId: 'oc_1', rootMessageId: 'om_1', title: '话题一', larkAppId: 'app_b', lastMessageAt: 20 },
    { sessionId: 's3', chatId: 'oc_2', rootMessageId: 'om_2', title: '话题二', larkAppId: 'app_a', lastMessageAt: 5 },
    { sessionId: 's4', chatId: 'oc_3', rootMessageId: 'om_3', scope: 'chat', title: '整群会话', larkAppId: 'app_a' },
  ];

  const entry = {
    chatId: 'oc_1',
    rootMessageId: 'om_1',
    title: '话题一',
    accessPolicyRef: 'deployment:topic-search',
  };

  function build(page: { messages?: unknown[]; complete?: boolean; nativeThreadId?: string }) {
    const fetchHistory = vi.fn(async () => ({
      messages: page.messages ?? [],
      complete: page.complete ?? true,
      ...(page.nativeThreadId ? { nativeThreadId: page.nativeThreadId } : {}),
    }));
    const source = createDaemonTopicSource({
      listSessions: () => sessions,
      fetchHistory,
      accessPolicyRef: 'deployment:topic-search',
      windowSize: 2,
      maxWindow: 2,
    });
    return { source, fetchHistory };
  }

  it('同一话题的多个 bot 会话只产出一个话题，并挑最活跃的来源', async () => {
    const { source, fetchHistory } = build({});
    const topics = await source.discoverTopics();
    expect(topics.map(topic => `${topic.chatId}:${topic.rootMessageId}`).sort()).toEqual(['oc_1:om_1', 'oc_2:om_2']);
    await source.readMessages(entry, { limit: 1 });
    expect(fetchHistory).toHaveBeenCalledWith(
      { sessionId: 's2', larkAppId: 'app_b' },
      expect.objectContaining({ limit: expect.any(Number) }),
    );
  });

  it('把游标边界传给 daemon（由它提前停止），而不是自己按「最新 N 条」猜', async () => {
    const { source, fetchHistory } = build({ messages: [] });
    await source.readMessages(entry, {
      limit: 1,
      after: { createTime: '2026-10-01T00:00:00.000Z', messageIds: ['om_100'] },
    });
    expect(fetchHistory).toHaveBeenCalledWith(
      { sessionId: 's2', larkAppId: 'app_b' },
      {
        limit: expect.any(Number),
        after: { createTime: '2026-10-01T00:00:00.000Z', messageIds: ['om_100'] },
      },
    );
  });

  it('daemon 回报 complete=false → truncated（上层据此不推进游标）', async () => {
    const { source } = build({
      complete: false,
      messages: [
        { messageId: 'om_101', createTime: Date.parse('2026-10-01T00:01:01.000Z'), content: 'x' },
      ],
    });
    const page = await source.readMessages(entry, {
      limit: 1,
      after: { createTime: '2026-10-01T00:00:00.000Z', messageIds: ['om_100'] },
    });
    expect(page.messages).toHaveLength(1);
    expect(page.truncated).toBe(true);
  });

  it('源侧标记 deleted 的消息原样透传（供更新器失效旧摘要）', async () => {
    const { source } = build({
      messages: [
        { messageId: 'om_101', createTime: Date.parse('2026-10-01T00:01:01.000Z'), content: '已撤回内容', deleted: true },
        { messageId: 'om_102', createTime: Date.parse('2026-10-01T00:02:01.000Z'), content: '正常内容' },
      ],
    });
    const page = await source.readMessages(entry, { limit: 10 });
    expect(page.messages.map(message => [message.messageId, message.deleted === true])).toEqual([
      ['om_101', true],
      ['om_102', false],
    ]);
  });

  it('complete=true 时可以正常提交，并带回原生话题 id', async () => {
    const { source } = build({
      complete: true,
      nativeThreadId: 'omt_1',
      messages: [
        { messageId: 'om_100', createTime: Date.parse('2026-10-01T00:00:00.000Z'), content: 'a' },
        { messageId: 'om_101', createTime: Date.parse('2026-10-01T00:01:00.000Z'), content: 'b' },
      ],
    });
    const page = await source.readMessages(entry, {
      limit: 1,
      after: { createTime: '2026-10-01T00:00:00.000Z', messageIds: ['om_100'] },
    });
    expect(page.truncated).toBe(false);
    expect(page.nativeThreadId).toBe('omt_1');
  });

  it('话题没有可用读取来源时报错，而不是返回空批次', async () => {
    const { source } = build({});
    await expect(
      source.readMessages(
        { chatId: 'oc_9', rootMessageId: 'om_9', title: '未知', accessPolicyRef: 'deployment:topic-search' },
        { limit: 1 },
      ),
    ).rejects.toMatchObject({ code: 'source_unavailable' });
  });
});
