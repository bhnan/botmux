/**
 * 话题源：发现「已知授权话题」并把它们的消息归一化 + 增量切分。
 *
 * 本模块只定义**契约与纯逻辑**：
 * - 具体飞书分页/凭证留在 IM/daemon 边界（实现 `TopicHistoryReader`），feature 不 import
 *   `daemon.ts` / `dashboard.ts`，也不集中持有任何 bot 凭证。
 * - 增量切分是纯函数，可脱离网络单测：同一毫秒到达的消息不能因为「按时间戳截断」被丢掉
 *   （游标里带边界毫秒上已处理的消息 id 集合），消息 id 不透明、**不能按字典序推断先后**。
 */

export interface TopicSourceMessage {
  messageId: string;
  /** ISO-8601 UTC；排序依据（源侧保证同一话题内可比）。 */
  createTime: string;
  text: string;
  senderName?: string;
  /** 源侧确认已删除/撤回：不进入新摘要，且应按 spec 使关联摘要失效。 */
  deleted?: boolean;
}

/** 已发现的话题目录项（身份字段只来自源元数据，不由模型填写）。 */
export interface TopicDirectoryEntry {
  chatId: string;
  rootMessageId: string;
  nativeThreadId?: string;
  title: string;
  /** 授权策略引用：同一次读取必须落在同一策略域内，否则拒绝混合摘要。 */
  accessPolicyRef: string;
}

export interface TopicSourceCursor {
  /** 已处理边界所在的毫秒。 */
  createTime: string;
  /** 边界毫秒上**已处理**的消息 id（同毫秒多条消息的完整去重依据）。 */
  messageIds: string[];
}

export interface TopicHistoryReadOptions {
  /**
   * 读取边界。更新器会传一个**早于**成功游标的边界（重叠窗口），用来核查
   * 已摘要消息是否被撤回；因此实现必须返回该边界之后的全部消息，且只有
   * 真正覆盖到边界时才能把 `complete` 置为 true。
   */
  after?: TopicSourceCursor;
  /** 本次最多读取多少条消息（源侧应把它翻成有界分页）。 */
  limit: number;
}

export interface TopicHistoryPage {
  messages: TopicSourceMessage[];
  /**
   * 是否确认读取的是原生话题容器。false = 退化成按 root_id 扫群，
   * 回复类消息可能天然缺席 —— 此时禁止把「缺席」判成删除。
   */
  verifiedThread?: boolean;
  /** 源侧是否因为预算/分页上限而截断：true 时调用方不能推进「检查完成」。 */
  truncated: boolean;
  /** 原生话题标识（`omt_*`）：只用于跳转，不能当路由身份（见 Topic.nativeThreadId）。 */
  nativeThreadId?: string;
}

export interface TopicHistoryReader {
  /** 枚举当前部署已知且有权限读取的 thread 话题。 */
  discoverTopics(): Promise<TopicDirectoryEntry[]>;
  /** 读取某个话题在 `after` 之后的新消息（按 createTime 升序）。 */
  readMessages(entry: TopicDirectoryEntry, options: TopicHistoryReadOptions): Promise<TopicHistoryPage>;
}

const CURSOR_VERSION = 1;

/** 游标编码（不透明字符串，落库为 `summarizedThroughCursor`）。 */
export function encodeCursor(cursor: TopicSourceCursor): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, t: cursor.createTime, ids: cursor.messageIds }),
    'utf8',
  ).toString('base64url');
}

export function decodeCursor(value: unknown): TopicSourceCursor | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      v?: unknown;
      t?: unknown;
      ids?: unknown;
    };
    if (parsed.v !== CURSOR_VERSION) return null;
    if (typeof parsed.t !== 'string' || !parsed.t) return null;
    if (!Array.isArray(parsed.ids) || parsed.ids.some(id => typeof id !== 'string')) return null;
    return { createTime: parsed.t, messageIds: parsed.ids as string[] };
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 归一化源消息：丢弃无 id/无时间的脏项，按 createTime 升序稳定排序。 */
export function normalizeSourceMessages(raw: readonly unknown[]): TopicSourceMessage[] {
  const messages: TopicSourceMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const messageId = nonEmptyString(record.messageId) || nonEmptyString(record.message_id);
    const createTime = nonEmptyString(record.createTime) || nonEmptyString(record.create_time);
    if (!messageId || !createTime) continue;
    const text = typeof record.text === 'string' ? record.text : '';
    const senderName = nonEmptyString(record.senderName) || nonEmptyString(record.sender_name);
    messages.push({
      messageId,
      createTime,
      text,
      ...(senderName ? { senderName } : {}),
      ...(record.deleted === true ? { deleted: true } : {}),
    });
  }
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) =>
      left.message.createTime.localeCompare(right.message.createTime) || left.index - right.index,
    )
    .map(entry => entry.message);
}

export interface IncrementSelection {
  /** 本批要送进摘要器的新消息（不含已处理/边界内重复项）。 */
  batch: TopicSourceMessage[];
  /** 提交成功后应写入的游标；没有新消息时等于入参 cursor。 */
  nextCursor: TopicSourceCursor | undefined;
  /** 还有超出 `limit` 的增量没读完 → 不能宣告「检查完成」。 */
  truncated: boolean;
}

/**
 * 从「源返回的消息」里切出**本次可提交的增量**。
 *
 * 边界规则（与 spec §5.1 对齐）：
 * - `createTime` 晚于游标边界的消息一律纳入；
 * - `createTime` **等于**边界的消息，只有 id 不在游标 `messageIds` 里才算新增 —— 否则同毫秒
 *   的第二条消息会被时间戳比较静默吞掉；
 * - 早于边界的消息视为已处理（源侧重复分页/乱序的兜底）。
 */
export function selectIncrement(input: {
  messages: readonly TopicSourceMessage[];
  cursor?: TopicSourceCursor;
  limit: number;
}): IncrementSelection {
  const limit = Math.max(1, Math.floor(input.limit));
  const cursor = input.cursor;
  const seenAtBoundary = new Set(cursor?.messageIds ?? []);
  const fresh: TopicSourceMessage[] = [];
  for (const message of input.messages) {
    if (cursor) {
      const comparison = message.createTime.localeCompare(cursor.createTime);
      if (comparison < 0) continue;
      if (comparison === 0 && seenAtBoundary.has(message.messageId)) continue;
    }
    fresh.push(message);
  }

  if (fresh.length === 0) {
    return { batch: [], nextCursor: cursor, truncated: false };
  }

  const batch = fresh.slice(0, limit);
  const last = batch[batch.length - 1];
  // 边界毫秒上所有**已处理**的 id 都要留在游标里：本批 + 之前的同毫秒 id。
  const boundaryIds = new Set<string>();
  if (cursor && cursor.createTime === last.createTime) {
    for (const id of cursor.messageIds) boundaryIds.add(id);
  }
  for (const message of batch) {
    if (message.createTime === last.createTime) boundaryIds.add(message.messageId);
  }

  return {
    batch,
    nextCursor: { createTime: last.createTime, messageIds: [...boundaryIds] },
    truncated: fresh.length > batch.length,
  };
}

/** 把源消息渲染成喂给摘要器的文本（有界：超长消息截断，保留首尾）。 */
export function renderMessageForPrompt(message: TopicSourceMessage, maxChars = 2_000): string {
  const text = message.text.replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  const head = Math.ceil((maxChars - 20) * 0.7);
  const tail = Math.max(0, maxChars - 20 - head);
  return `${text.slice(0, head)} … ${text.slice(text.length - tail)}`;
}
