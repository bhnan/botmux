import { describe, expect, it } from 'vitest';
import {
  isRealRoutingAnchor,
  parseThreadTopicKey,
  sessionTopicKey,
  threadTopicKey,
  topicIdentityFromSessionRow,
  topicNativeThreadId,
} from '../src/topic/identity.js';
import { groupSessionsByTopic, sessionTopicKey as reExportedKey } from '../src/dashboard/web/sessions.js';

const chatA = 'oc_chat_alpha';
const chatB = 'oc_chat_beta';
const root1 = 'om_root_0001';
const root2 = 'om_root_0002';

function threadRow(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    chatId: chatA,
    rootMessageId: root1,
    scope: 'thread',
    chatType: 'group',
    title: 'Topic A',
    ...overrides,
  };
}

describe('sessionTopicKey（与现有 dashboard 编码一致）', () => {
  it('同一 thread 的多个 session 得到同一 key（A-01）', () => {
    const rows = [
      threadRow({ sessionId: 's1', title: 'first session' }),
      threadRow({ sessionId: 's2', title: 'second session' }),
      threadRow({ sessionId: 's3', title: 'third session' }),
    ];
    const keys = new Set(rows.map(row => sessionTopicKey(row)));
    expect(keys.size).toBe(1);
    expect(groupSessionsByTopic(rows)).toHaveLength(1);
  });

  it('不同群的相同根消息/标题不合并（A-01）', () => {
    const keyA = sessionTopicKey(threadRow({ chatId: chatA }));
    const keyB = sessionTopicKey(threadRow({ chatId: chatB }));
    expect(keyA).not.toBe(keyB);
    // 同一群、不同根消息也是不同话题（fork 语义）
    expect(sessionTopicKey(threadRow({ rootMessageId: root2 }))).not.toBe(keyA);
  });

  it('dashboard re-export 与 identity 模块逐字一致', () => {
    expect(reExportedKey).toBe(sessionTopicKey);
    expect(reExportedKey(threadRow())).toBe(sessionTopicKey(threadRow()));
  });

  it('chat/session 桶不误判为 thread（A-09）', () => {
    expect(sessionTopicKey({ chatId: chatA, scope: 'chat', sessionId: 's1' })).toMatch(/^chat:/);
    expect(sessionTopicKey({ chatId: chatA, rootMessageId: root1, scope: 'chat', sessionId: 's1' })).toMatch(/^chat:/);
    expect(sessionTopicKey({ sessionId: 's1' })).toMatch(/^session:/);
  });
});

describe('threadTopicKey / parseThreadTopicKey', () => {
  it('与 sessionTopicKey 的 thread 编码一致', () => {
    expect(threadTopicKey(chatA, root1)).toBe(sessionTopicKey(threadRow()));
  });

  it('往返编码/解码，含 URL 保留字符与中文', () => {
    for (const [chatId, rootId] of [
      [chatA, root1],
      ['oc_中文群', 'om_根:消息/1'],
      ['oc_a%b', 'om_x?y=z'],
    ] as const) {
      const parsed = parseThreadTopicKey(threadTopicKey(chatId, rootId));
      expect(parsed).toEqual({ chatId, rootMessageId: rootId });
    }
  });

  it('非 thread key 与畸形输入返回 null', () => {
    expect(parseThreadTopicKey('chat:oc_x')).toBeNull();
    expect(parseThreadTopicKey('session:s1')).toBeNull();
    expect(parseThreadTopicKey('thread:')).toBeNull();
    expect(parseThreadTopicKey('thread:oc_x:')).toBeNull();
    expect(parseThreadTopicKey('thread::om_x')).toBeNull();
  });
});

describe('topicIdentityFromSessionRow（首版目录准入）', () => {
  it('thread 群会话产出 Topic 身份', () => {
    expect(topicIdentityFromSessionRow(threadRow())).toEqual({
      topicKey: threadTopicKey(chatA, root1),
      chatId: chatA,
      rootMessageId: root1,
    });
  });

  it('chat-scope 与缺根 ID 的会话明确跳过（A-09）', () => {
    expect(topicIdentityFromSessionRow(threadRow({ scope: 'chat' }))).toBeNull();
    expect(topicIdentityFromSessionRow(threadRow({ rootMessageId: '' }))).toBeNull();
    expect(topicIdentityFromSessionRow(threadRow({ chatId: '' }))).toBeNull();
    expect(topicIdentityFromSessionRow(null)).toBeNull();
  });

  it('DM（p2p）不建 Topic', () => {
    expect(topicIdentityFromSessionRow(threadRow({ chatType: 'p2p' }))).toBeNull();
  });

  it('headless 合成会话不建 Topic', () => {
    expect(topicIdentityFromSessionRow(threadRow({ headless: { id: 'h1', createdAt: '2026-10-29T00:00:00Z', source: 'cli' } }))).toBeNull();
  });

  it('虚拟路由锚点（schedule-task:*）不建 Topic；绑定真实 om_ 根后进入目录（延迟绑定）', () => {
    const virtualAnchor = 'schedule-task:task_42';
    // 未落地：deferred schedule run 持虚拟锚点
    expect(topicIdentityFromSessionRow(threadRow({ rootMessageId: virtualAnchor }))).toBeNull();
    expect(isRealRoutingAnchor(virtualAnchor)).toBe(false);
    // 落地后：换上真实 om_ 根消息（deferred-topic-binding 以 om_ 为真实根标记）
    const materialized = threadRow({ rootMessageId: root1 });
    expect(topicIdentityFromSessionRow(materialized)?.rootMessageId).toBe(root1);
    expect(isRealRoutingAnchor(root1)).toBe(true);
  });

  it('relay 后身份跟随目标话题；旧话题 key 不受影响（A-09: 不混淆来源）', () => {
    const before = topicIdentityFromSessionRow(threadRow());
    const relayed = topicIdentityFromSessionRow(threadRow({ chatId: chatB, rootMessageId: root2 }));
    expect(relayed).toEqual({ topicKey: threadTopicKey(chatB, root2), chatId: chatB, rootMessageId: root2 });
    // 旧 key 仍然合法可解析：持久目录中旧话题记录不被搬走
    expect(parseThreadTopicKey(before!.topicKey)).toEqual({ chatId: chatA, rootMessageId: root1 });
  });

  it('fork 产生的新根得到独立话题身份', () => {
    const source = topicIdentityFromSessionRow(threadRow());
    const forked = topicIdentityFromSessionRow(threadRow({ rootMessageId: root2 }));
    expect(forked!.topicKey).not.toBe(source!.topicKey);
  });
});

describe('topicNativeThreadId（原生跳转标识）', () => {
  it('合法 omt_* 保留，非法值丢弃', () => {
    expect(topicNativeThreadId(threadRow({ larkThreadId: 'omt_ABC123' }))).toBe('omt_ABC123');
    expect(topicNativeThreadId(threadRow({ larkThreadId: root1 }))).toBeUndefined();
    expect(topicNativeThreadId(threadRow({ larkThreadId: 'not-a-thread' }))).toBeUndefined();
    expect(topicNativeThreadId(threadRow({}))).toBeUndefined();
  });

  it('原生线程 ID 与路由根消息不可互换', () => {
    // 用 omt_* 冒充 rootMessageId 不得通过真实锚点校验
    expect(isRealRoutingAnchor('omt_ABC123')).toBe(false);
    // 用 om_* 冒充原生线程 ID 不得通过 native 校验
    expect(topicNativeThreadId(threadRow({ larkThreadId: root1 }))).toBeUndefined();
  });
});
