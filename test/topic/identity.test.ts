import { describe, expect, it } from 'vitest';
import { sessionTopicKey, topicIdentity } from '../../src/topic/identity.js';

describe('thread identity independent of execution sessions', () => {
  it('shares the location across sessions, but separates chats and forked topics', () => {
    const location = { chatId: 'oc_a', rootMessageId: 'om_root', scope: 'thread' };
    expect(sessionTopicKey({ ...location, sessionId: 'one' })).toBe(sessionTopicKey({ ...location, sessionId: 'two' }));
    expect(sessionTopicKey({ ...location, chatId: 'oc_b' })).not.toBe(sessionTopicKey(location));
    expect(sessionTopicKey({ ...location, rootMessageId: 'om_fork' })).not.toBe(sessionTopicKey(location));
  });
  it('preserves the established encoded wire key for non-ASCII and separators', () => {
    expect(sessionTopicKey({ chatId: '群:a', rootMessageId: 'om_x:y' })).toBe('thread:%E7%BE%A4%3Aa:om_x%3Ay');
    expect(sessionTopicKey({ chatId: 'oc_a', scope: 'chat', rootMessageId: 'om_root' })).toBe('chat:oc_a');
    expect(sessionTopicKey({ sessionId: 'one' })).toBe('session:one');
  });
  it('waits for a real routing anchor; native topic id is only a jump identifier', () => {
    for (const rootMessageId of ['', 'deferred:task', 'omt_native']) {
      expect(topicIdentity({ chatId: 'oc_a', rootMessageId })).toBeNull();
    }
    expect(topicIdentity({ chatId: 'oc_a', rootMessageId: 'om_root', larkThreadId: 'omt_native' }))
      .toMatchObject({ topicKey: 'thread:oc_a:om_root', nativeThreadId: 'omt_native' });
    expect(topicIdentity({ chatId: 'oc_a', rootMessageId: 'om_root', scope: 'chat' })).toBeNull();
  });
});
