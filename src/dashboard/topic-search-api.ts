/** Dashboard host adapter for topic search (spec §2/§6.2).
 *
 * Owns three concerns that must NOT leak into src/topic/ (which stays
 * dashboard-free):
 * 1. The background runtime's lifecycle: config resolution from
 *    ~/.botmux/config.json, mounting into the Dashboard process, and the
 *    daemon-IPC-backed history reader (registry → owning daemon's
 *    /api/topic-messages route).
 * 2. The query entry used by POST /api/topic-search: candidates come from the
 *    runtime's catalog (already bounded by the configured allowed-chat
 *    authorization), the search service ranks them.
 * 3. Feature-off behavior: nothing starts, queries answer 403.
 */
import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';
import { readGlobalConfig, type TopicSearchGlobalConfig } from '../global-config.js';
import { embedSummaryText } from '../topic/embedding-client.js';
import { resolveTopicSearchConfig, type TopicSearchConfig } from '../topic/config.js';
import { TopicSearchRuntime } from '../topic/runtime.js';
import { TopicSearchService, type TopicSearchInput, type TopicSearchOutput } from '../topic/search.js';
import type { TopicHistoryWindow, TopicReadTarget } from '../topic/source.js';
import { logger } from '../utils/logger.js';

export interface TopicSearchHostRegistry {
  list(): Array<{ larkAppId: string; ipcPort: number }>;
}

export interface TopicSearchHostDeps {
  /** Daemon registry for read routing. */
  registry: TopicSearchHostRegistry;
  /** Dashboard session rows — the runtime's discovery source. */
  getSessions: () => Array<Record<string, unknown>>;
  /** SQLite data dir for the topic store (e.g. ~/.botmux/topic-search). */
  dataDir: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** Resolve the effective config live (spec: 停用检查在每个提交/外发边界). */
function resolveLiveConfig(raw: TopicSearchGlobalConfig | undefined): TopicSearchConfig | null {
  const resolution = resolveTopicSearchConfig(raw as never);
  return resolution.enabled ? resolution.config : null;
}

async function readTopicWindowViaDaemon(
  deps: TopicSearchHostDeps,
  target: TopicReadTarget,
): Promise<TopicHistoryWindow> {
  const port = target.larkAppId
    ? deps.registry.list().find(d => d.larkAppId === target.larkAppId)?.ipcPort
    : undefined;
  if (!port) throw new Error(`topic_search_no_reader_daemon:${target.topicKey}`);
  const params = new URLSearchParams({
    chatId: target.chatId,
    rootMessageId: target.rootMessageId,
    limit: '200',
  });
  const response = await fetchDaemonIpc(port, `/api/topic-messages?${params.toString()}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`topic_search_read_http_${response.status}`);
  const body = await response.json() as {
    ok?: boolean;
    truncated?: boolean;
    messages?: Array<{ messageId: string; senderType?: string; senderName?: string; text?: string; createTimeMs?: number }>;
  };
  if (body.ok !== true) throw new Error('topic_search_read_unavailable');
  return {
    messages: (body.messages ?? []).map(m => ({
      messageId: m.messageId,
      senderType: m.senderType === 'app' ? 'app' : 'user',
      ...(m.senderName ? { senderName: m.senderName } : {}),
      ...(m.createTimeMs !== undefined ? { createTimeMs: m.createTimeMs } : {}),
      text: typeof m.text === 'string' ? m.text : '',
    })),
    truncated: body.truncated === true,
  };
}

interface HostState {
  runtime: TopicSearchRuntime;
  config: TopicSearchConfig;
  hostDeps: TopicSearchHostDeps;
}

let host: HostState | null = null;
let startPromise: Promise<HostState | null> | null = null;

/** Mount the background runtime + query service into the Dashboard process.
 * Idempotent; resolves null when the feature is off (nothing started). */
export async function startTopicSearchHost(deps: TopicSearchHostDeps): Promise<HostState | null> {
  if (host) return host;
  if (startPromise) return startPromise;
  startPromise = (async () => {
    const config = resolveLiveConfig(readGlobalConfig().topicSearch);
    if (!config) return null;
    const runtime = await TopicSearchRuntime.create({
      dataDir: deps.dataDir,
      getConfig: () => resolveLiveConfig(readGlobalConfig().topicSearch),
      discoverRows: () => deps.getSessions(),
      readHistory: target => readTopicWindowViaDaemon(deps, target),
      fetchImpl: deps.fetchImpl,
      env: deps.env,
      logger: {
        info: message => logger.info(`[topic-search] ${message}`),
        warn: message => logger.warn(`[topic-search] ${message}`),
      },
    });
    runtime.start();
    host = { runtime, config, hostDeps: deps };
    logger.info('[topic-search] background runtime started');
    return host;
  })();
  try {
    return await startPromise;
  } finally {
    startPromise = null;
  }
}

export async function stopTopicSearchHost(): Promise<void> {
  const current = host;
  host = null;
  if (current) await current.runtime.stop();
}

export function topicSearchHostActive(): boolean {
  return host !== null;
}

export type { TopicSearchInput, TopicSearchOutput };

export interface TopicSearchQueryOutcome {
  status: number;
  body:
    | { ok: true; result: TopicSearchOutput }
    | { ok: false; error: string };
}

/** Handle POST /api/topic-search. Caller has already enforced Dashboard auth. */
export async function handleTopicSearchQuery(input: TopicSearchInput): Promise<TopicSearchQueryOutcome> {
  const state = host;
  if (!state) return { status: 403, body: { ok: false, error: 'topic_search_disabled' } };
  const config = resolveLiveConfig(readGlobalConfig().topicSearch);
  if (!config) return { status: 403, body: { ok: false, error: 'topic_search_disabled' } };
  // Live authorization on the query path too: a chat removed from
  // allowedChatIds stops being searchable immediately (spec §5.4 / A-10).
  const allowed = new Set(config.allowedChatIds);
  const candidates = state.runtime.topicStore.listTopics().filter(topic => allowed.has(topic.chatId));
  // Embedding is resolved from the LIVE config per query — the query path
  // must never keep sending embedding requests after the operator turned
  // them off, nor stay keyword-only after they were turned on (复核 P2-7).
  const serviceOptions: ConstructorParameters<typeof TopicSearchService>[0] = {};
  if (config.embedding.enabled) {
    const embeddingModel = config.embedding.model;
    const embedFetch = state.hostDeps;
    serviceOptions.embedQuery = async text => embedSummaryText(embeddingModel, text, {
      ...(embedFetch.fetchImpl ? { fetchImpl: embedFetch.fetchImpl } : {}),
      ...(embedFetch.env ? { env: embedFetch.env } : {}),
    });
  }
  const service = new TopicSearchService(serviceOptions);
  try {
    const result = await service.search({ ...input, indexVersion: state.runtime.topicStore.catalogVersion() }, candidates);
    return { status: 200, body: { ok: true, result } };
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'invalid_request';
    const status = code === 'query_invalid' || code === 'limit_invalid' || code === 'cursor_invalid' ? 400 : 503;
    return { status, body: { ok: false, error: code } };
  }
}
