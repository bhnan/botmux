/**
 * 通过**已认证的 daemon 内部调用**读取话题历史（首版默认实现）。
 *
 * 为什么不在中心进程直接调飞书：应用凭证留在各 bot daemon（spec §2.1/§7）。这里只
 * 依赖两个由宿主注入的能力：
 * - `listSessions()`：Dashboard 已汇总的会话行，用来发现已知授权话题；
 * - `fetchHistory(sessionId, limit)`：daemon 侧的 `GET /api/sessions/:id/history`，
 *   由持有该 app 凭证的 daemon 去拉消息。
 *
 * 窗口覆盖规则（本模块真正的逻辑，不是胶水）：
 * daemon 的历史接口只能「取最新 N 条」，不能从游标续读。若窗口取满且最老一条仍晚于
 * 上次成功处理的游标，说明游标与窗口之间的消息读不到——此时报 `truncated` 且**不推进
 * 游标**（上层记为 `source_window_too_narrow` 失败），而不是把窗口内的几条当增量提交、
 * 把中间一段永久跳过。
 */

import { isNativeTopicId } from '../core/native-topic-id.js';
import { threadAnchorOf, threadTopicKey, topicFallbackTitle } from './identity.js';
import {
  normalizeSourceMessages,
  type TopicDirectoryEntry,
  type TopicHistoryPage,
  type TopicHistoryReadOptions,
  type TopicHistoryReader,
  type TopicSourceCursor,
  type TopicSourceMessage,
} from './source.js';

/** 发现话题所需的最小会话字段（Dashboard 行数据超集即可）。 */
export interface TopicSourceSessionRow {
  sessionId?: unknown;
  chatId?: unknown;
  rootMessageId?: unknown;
  scope?: unknown;
  title?: unknown;
  botName?: unknown;
  larkAppId?: unknown;
  lastMessageAt?: unknown;
  status?: unknown;
}

/** daemon `GET /api/topics/messages` 返回的消息形状（子集）。 */
export interface DaemonHistoryMessage {
  messageId?: unknown;
  content?: unknown;
  createTime?: unknown;
  senderName?: unknown;
  msgType?: unknown;
  /** 源侧确认已撤回/删除（飞书 message 资源的 `deleted`）。 */
  deleted?: unknown;
}

export interface DaemonHistoryPage {
  messages: readonly DaemonHistoryMessage[];
  /** false = 窗口没覆盖到调用方给的处理边界（预算/页数用尽）→ 不得推进游标。 */
  complete: boolean;
  nativeThreadId?: string;
  /** false = 退化成按 root_id 扫群，回复可能缺席 → 不能据此判删除。 */
  verifiedThread?: boolean;
}

export interface DaemonTopicSourceDeps {
  listSessions: () => readonly TopicSourceSessionRow[] | Promise<readonly TopicSourceSessionRow[]>;
  /** 由宿主提供：走已签名的 daemon 内部调用。
   *  `after` 是上次成功处理的边界，daemon 侧据此「从新往旧翻到边界就停」；
   *  返回的 `complete` 为 false 时调用方**不得**推进游标。 */
  fetchHistory: (
    session: { sessionId: string; larkAppId?: string },
    options: { limit: number; after?: TopicSourceCursor },
  ) => Promise<DaemonHistoryPage>;
  /** 授权策略引用（宿主决定；同一次读取必须落在同一策略域内）。 */
  accessPolicyRef: string;
  windowSize?: number;
  maxWindow?: number;
}

/** daemon 话题历史接口的硬上限（`/api/topics/messages` 把 limit 夹到 200）。 */
export const DAEMON_HISTORY_MAX_LIMIT = 200;
const DEFAULT_WINDOW = 200;

/**
 * daemon `/api/topics/messages` 响应 → 内部页面对象。
 *
 * `verifiedThread` 采用 **fail-closed**：只有响应明确是 `true` 才允许更新器用
 * 「消息缺席」推断删除。缺字段（旧版本/代理丢字段）时宁可少删，也不能误删存活内容。
 */
export function parseDaemonHistoryBody(body: unknown): DaemonHistoryPage {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  return {
    messages: Array.isArray(record.messages) ? record.messages as DaemonHistoryMessage[] : [],
    complete: record.complete === true,
    ...(typeof record.nativeThreadId === 'string' ? { nativeThreadId: record.nativeThreadId } : {}),
    verifiedThread: record.verifiedThread === true,
  };
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toSourceMessage(raw: DaemonHistoryMessage): TopicSourceMessage | null {
  const messageId = nonEmptyString(raw.messageId);
  const createTimeRaw = Number(raw.createTime);
  if (!messageId || !Number.isFinite(createTimeRaw) || createTimeRaw <= 0) return null;
  const text = typeof raw.content === 'string' ? raw.content : '';
  const senderName = nonEmptyString(raw.senderName);
  return {
    messageId,
    createTime: new Date(createTimeRaw).toISOString(),
    text,
    ...(senderName ? { senderName } : {}),
    ...(raw.deleted === true ? { deleted: true } : {}),
  };
}

export function createDaemonTopicSource(deps: DaemonTopicSourceDeps): TopicHistoryReader {
  const windowSize = Math.min(deps.windowSize ?? DEFAULT_WINDOW, deps.maxWindow ?? DAEMON_HISTORY_MAX_LIMIT);
  const maxWindow = Math.min(Math.max(windowSize, deps.maxWindow ?? DEFAULT_WINDOW), DAEMON_HISTORY_MAX_LIMIT);
  const sessionByTopic = new Map<string, { sessionId: string; larkAppId?: string }>();

  async function refreshDirectory(): Promise<TopicDirectoryEntry[]> {
    const rows = await deps.listSessions();
    const best = new Map<
      string,
      { entry: TopicDirectoryEntry; activity: number; sessionId: string; larkAppId?: string }
    >();
    for (const row of rows) {
      const sessionId = nonEmptyString(row.sessionId);
      if (!sessionId) continue;
      // 首版只索引真实 thread 话题：粒度判定复用话题身份模块，别在这里另写一套。
      const anchor = threadAnchorOf({
        chatId: row.chatId,
        rootMessageId: row.rootMessageId,
        scope: row.scope,
        sessionId: row.sessionId,
      });
      if (!anchor) continue;
      const { chatId, rootMessageId } = anchor;
      const key = threadTopicKey(chatId, rootMessageId);
      const activity = Number(row.lastMessageAt);
      const entry: TopicDirectoryEntry = {
        chatId,
        rootMessageId,
        title:
          nonEmptyString(row.title) ||
          nonEmptyString(row.botName) ||
          topicFallbackTitle({ chatId, rootMessageId }, key),
        accessPolicyRef: deps.accessPolicyRef,
      };
      const current = best.get(key);
      // 同一话题有多个 bot 的会话：只挑一个固定来源（最近活跃），
      // 避免同一轮里来回换来源导致重复/漏读。
      if (!current || (Number.isFinite(activity) ? activity : 0) > current.activity) {
        const larkAppId = nonEmptyString(row.larkAppId);
        best.set(key, {
          entry,
          activity: Number.isFinite(activity) ? activity : 0,
          sessionId,
          ...(larkAppId ? { larkAppId } : {}),
        });
      }
    }
    sessionByTopic.clear();
    for (const [key, value] of best) {
      sessionByTopic.set(key, {
        sessionId: value.sessionId,
        ...(value.larkAppId ? { larkAppId: value.larkAppId } : {}),
      });
    }
    return [...best.values()].map(value => value.entry);
  }

  async function readMessages(
    entry: TopicDirectoryEntry,
    options: TopicHistoryReadOptions,
  ): Promise<TopicHistoryPage> {
    const key = threadTopicKey(entry.chatId, entry.rootMessageId);
    let session = sessionByTopic.get(key);
    if (!session) {
      await refreshDirectory();
      session = sessionByTopic.get(key);
    }
    if (!session) {
      throw Object.assign(new Error('no readable source for topic'), { code: 'source_unavailable' });
    }

    const requested = Math.min(Math.max(windowSize, options.limit * 4), maxWindow);
    const page = await deps.fetchHistory(session, {
      limit: requested,
      ...(options.after ? { after: options.after } : {}),
    });
    const messages = normalizeSourceMessages(
      page.messages.map(toSourceMessage).filter((item): item is TopicSourceMessage => item !== null),
    );
    // daemon 侧已经按边界提前停止；`complete` 是唯一的完整性判据，不再靠
    // 「窗口是否取满 + 时间戳比较」去猜（那会在同毫秒多条消息时判断错）。
    return {
      messages,
      truncated: !page.complete,
      verifiedThread: page.verifiedThread === true,
      // 原生话题 id 只接受 `omt_*` 形状：它只用于跳转，形状不对就当作没有，
      // 免得把路由根消息 id（om_*）当话题 id 拼出打不开的链接。
      ...(isNativeTopicId(page.nativeThreadId) ? { nativeThreadId: page.nativeThreadId } : {}),
    };
  }

  return {
    async discoverTopics() {
      return refreshDirectory();
    },
    readMessages,
  };
}
