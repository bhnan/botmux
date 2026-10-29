/**
 * 话题身份：一条会话记录属于哪个飞书话题（纯函数，**必须保持浏览器可引用**）。
 *
 * 这里只做「从会话行推导话题锚点」与「话题 key 的编码/解析」，不 import 任何
 * Node-only 模块：Dashboard 的浏览器 bundle 直接引用本文件（见
 * `dashboard/web/sessions.ts`），打包器不能顺着这里把 `node:fs`/`node:sqlite` 拉进去。
 *
 * topicKey 是**持久化契约**：Dashboard 聚合、Topic 目录、检索结果里的 `topicKey`
 * 全部按它对齐，历史数据也是这个编码。因此编码规则必须与既有 `sessionTopicKey`
 * 逐字一致，改动等于破坏既有数据 —— `test/topic-identity.test.ts` 钉住字节级兼容。
 */

/** 话题锚点的三种粒度。`thread` 才是真实飞书话题；`chat` 是整群一会话；
 *  `session` 表示连会话锚点都没有（无 chatId 或无根消息的自定义会话）。 */
export type TopicScope = 'thread' | 'chat' | 'session';

/** 推导话题身份所需的会话行字段（只要这几个，其余字段无关）。 */
export interface TopicAnchorFields {
  chatId?: unknown;
  rootMessageId?: unknown;
  /** `'thread'`（缺省，按 rootMessageId 路由）或 `'chat'`（整群一会话）。 */
  scope?: unknown;
  sessionId?: unknown;
}

/** 可索引的真实话题锚点：两者都非空才成立。 */
export interface ThreadTopicAnchor {
  chatId: string;
  rootMessageId: string;
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 话题粒度判定：chat scope 优先；thread 需要 chatId + rootMessageId 都在；
 *  否则退化为 session 粒度。 */
export function topicScopeOf(anchor: TopicAnchorFields): TopicScope {
  const chatId = nonEmptyString(anchor.chatId);
  const rootMessageId = nonEmptyString(anchor.rootMessageId);
  if (anchor.scope === 'chat') return chatId ? 'chat' : 'session';
  return chatId && rootMessageId ? 'thread' : 'session';
}

/** 稳定话题 key（持久化契约，按 scope 分支编码）。 */
export function topicKeyOf(anchor: TopicAnchorFields): string {
  const chatId = nonEmptyString(anchor.chatId);
  const rootMessageId = nonEmptyString(anchor.rootMessageId);
  const scope = topicScopeOf(anchor);
  if (scope === 'thread') {
    return `thread:${encodeURIComponent(chatId)}:${encodeURIComponent(rootMessageId)}`;
  }
  if (scope === 'chat') return `chat:${encodeURIComponent(chatId)}`;
  return `session:${encodeURIComponent(nonEmptyString(anchor.sessionId) || 'unknown')}`;
}

/** 真实话题（`kind=thread`）的锚点；不是 thread 一律返回 null —— 首版只索引
 *  thread 话题，调用方不得把 chat/session 粒度硬塞进 Topic。 */
export function threadAnchorOf(anchor: TopicAnchorFields): ThreadTopicAnchor | null {
  if (topicScopeOf(anchor) !== 'thread') return null;
  return {
    chatId: nonEmptyString(anchor.chatId),
    rootMessageId: nonEmptyString(anchor.rootMessageId),
  };
}

/** 由 chatId + rootMessageId 直接构造 thread 话题 key（源适配器/存储用）。 */
export function threadTopicKey(chatId: string, rootMessageId: string): string {
  return `thread:${encodeURIComponent(nonEmptyString(chatId))}:${encodeURIComponent(nonEmptyString(rootMessageId))}`;
}

export interface ParsedTopicKey {
  scope: TopicScope;
  chatId?: string;
  rootMessageId?: string;
  sessionId?: string;
}

/**
 * 解析 topicKey。用于从持久化的 key 还原路由字段（存储/检索/权限过滤）。
 *
 * 不认识的形状返回 null，而不是猜一个 scope —— 类型系统外的脏 key 必须由调用方
 * 显式丢弃，否则会把别的粒度当成 thread 索引。
 */
export function parseTopicKey(key: unknown): ParsedTopicKey | null {
  const raw = nonEmptyString(key);
  if (!raw) return null;
  const separator = raw.indexOf(':');
  if (separator <= 0) return null;
  const scope = raw.slice(0, separator);
  const rest = raw.slice(separator + 1);
  try {
    if (scope === 'thread') {
      const parts = rest.split(':');
      if (parts.length !== 2) return null;
      const chatId = decodeURIComponent(parts[0]);
      const rootMessageId = decodeURIComponent(parts[1]);
      if (!chatId || !rootMessageId) return null;
      return { scope: 'thread', chatId, rootMessageId };
    }
    if (scope === 'chat') {
      const chatId = decodeURIComponent(rest);
      if (!chatId) return null;
      return { scope: 'chat', chatId };
    }
    if (scope === 'session') {
      const sessionId = decodeURIComponent(rest);
      if (!sessionId) return null;
      return { scope: 'session', sessionId };
    }
  } catch {
    // 非法百分号编码：当作脏 key。
    return null;
  }
  return null;
}

/** 话题展示名兜底：根消息 id → chatId → sessionId → key 本体。 */
export function topicFallbackTitle(anchor: TopicAnchorFields, key?: string): string {
  const chatId = nonEmptyString(anchor.chatId);
  const rootMessageId = nonEmptyString(anchor.rootMessageId);
  return (
    rootMessageId ||
    chatId ||
    nonEmptyString(anchor.sessionId) ||
    nonEmptyString(key) ||
    'topic'
  );
}
