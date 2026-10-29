import { describe, expect, it } from 'vitest';
import {
  parseTopicKey,
  threadAnchorOf,
  threadTopicKey,
  topicFallbackTitle,
  topicKeyOf,
  topicScopeOf,
} from '../src/topic/identity.js';
import { sessionTopicKey } from '../src/dashboard/web/sessions.js';

/**
 * topicKey 是持久化标识（Dashboard 聚合 / Topic 目录 / 检索结果都按它对齐），
 * 所以这里的字面量断言钉的是**对外编码契约**，不是内部实现细节：换实现可以，
 * 换编码就会把已有话题数据切成两半。
 */
describe('话题身份编码（持久化契约）', () => {
  it('thread 话题按 chatId:rootMessageId 编码，并转义保留分隔符', () => {
    expect(topicKeyOf({ chatId: 'oc_1', rootMessageId: 'om_1' })).toBe('thread:oc_1:om_1');
    // ':' 在 chatId/rootMessageId 里必须被转义，否则 key 无法无歧义解析。
    expect(topicKeyOf({ chatId: 'oc:a', rootMessageId: 'om:b' })).toBe('thread:oc%3Aa:om%3Ab');
  });

  it('chat scope 与无锚点会话降级到各自的编码', () => {
    expect(topicScopeOf({ scope: 'chat', chatId: 'oc_1', rootMessageId: 'om_1' })).toBe('chat');
    expect(topicKeyOf({ scope: 'chat', chatId: 'oc_1', rootMessageId: 'om_1' })).toBe('chat:oc_1');
    expect(topicKeyOf({ scope: 'chat' })).toBe('session:unknown');
    expect(topicKeyOf({ chatId: 'oc_1', sessionId: 'sess_9' })).toBe('session:sess_9');
  });

  it('空白与缺失字段按未定义处理，不产生半截 key', () => {
    expect(topicScopeOf({ chatId: '  ', rootMessageId: 'om_1' })).toBe('session');
    expect(topicKeyOf({ chatId: ' oc_1 ', rootMessageId: ' om_1 ' })).toBe('thread:oc_1:om_1');
    expect(topicKeyOf({})).toBe('session:unknown');
  });

  it('threadAnchorOf 只认 thread：chat/session 粒度必须被拒绝', () => {
    expect(threadAnchorOf({ chatId: 'oc_1', rootMessageId: 'om_1' })).toEqual({
      chatId: 'oc_1',
      rootMessageId: 'om_1',
    });
    expect(threadAnchorOf({ scope: 'chat', chatId: 'oc_1', rootMessageId: 'om_1' })).toBeNull();
    expect(threadAnchorOf({ chatId: 'oc_1' })).toBeNull();
    expect(threadAnchorOf({ chatId: 'oc_1', rootMessageId: '   ' })).toBeNull();
  });

  it('threadTopicKey 与 topicKeyOf 对同一锚点产出同一个 key', () => {
    const anchor = { chatId: 'oc_9', rootMessageId: 'om_9' };
    expect(threadTopicKey('oc_9', 'om_9')).toBe(topicKeyOf(anchor));
  });
});

describe('话题 key 解析', () => {
  it('三种 scope 都能往返', () => {
    const thread = topicKeyOf({ chatId: 'oc:1', rootMessageId: 'om 2' });
    expect(parseTopicKey(thread)).toEqual({
      scope: 'thread',
      chatId: 'oc:1',
      rootMessageId: 'om 2',
    });
    expect(parseTopicKey(topicKeyOf({ scope: 'chat', chatId: 'oc_1' }))).toEqual({
      scope: 'chat',
      chatId: 'oc_1',
    });
    expect(parseTopicKey(topicKeyOf({ sessionId: 's:1' }))).toEqual({
      scope: 'session',
      sessionId: 's:1',
    });
  });

  it('脏 key 一律返回 null，不猜 scope', () => {
    for (const bad of ['', '   ', 'thread', 'thread:oc_1', 'thread:a:b:c', 'unknown:oc_1', 'thread:%E0%A4%A:om_1', null, undefined, 42]) {
      expect(parseTopicKey(bad)).toBeNull();
    }
  });
});

describe('与 Dashboard 聚合共用同一份身份判定', () => {
  // 既有 Dashboard 代码通过 sessionTopicKey 算 key；Topic 目录必须与它逐字一致，
  // 否则「同一个话题」在 Dashboard 和检索结果里会是两个。
  it('sessionTopicKey 与 topicKeyOf 对相同行给出相同 key', () => {
    const rows = [
      { chatId: 'oc_1', rootMessageId: 'om_1' },
      { chatId: 'oc_1', rootMessageId: 'om_1', sessionId: 's1' },
      { chatId: 'oc_1', rootMessageId: 'om_1', scope: 'chat' },
      { chatId: 'oc_1' },
      {},
    ];
    for (const row of rows) expect(sessionTopicKey(row)).toBe(topicKeyOf(row));
  });

  it('同一话题下多个 session 归并到一个 key，不同群即使标题相同也不合并', () => {
    const a = { chatId: 'oc_1', rootMessageId: 'om_1', sessionId: 's1', title: '同一个标题' };
    const b = { chatId: 'oc_1', rootMessageId: 'om_1', sessionId: 's2', title: '同一个标题' };
    const otherChat = { chatId: 'oc_2', rootMessageId: 'om_1', sessionId: 's3', title: '同一个标题' };
    expect(sessionTopicKey(a)).toBe(sessionTopicKey(b));
    expect(sessionTopicKey(a)).not.toBe(sessionTopicKey(otherChat));
  });
});

describe('话题展示名兜底', () => {
  it('按 rootMessageId → chatId → sessionId → key 依次兜底', () => {
    expect(topicFallbackTitle({ chatId: 'oc_1', rootMessageId: 'om_1' })).toBe('om_1');
    expect(topicFallbackTitle({ chatId: 'oc_1' })).toBe('oc_1');
    expect(topicFallbackTitle({ sessionId: 's1' }, 'session:s1')).toBe('s1');
    expect(topicFallbackTitle({}, 'thread:x:y')).toBe('thread:x:y');
  });
});
