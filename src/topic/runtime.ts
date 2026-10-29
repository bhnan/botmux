/**
 * 话题知识 runtime：把 store / source / enricher / embedder / scheduler / search 组合起来。
 *
 * 生命周期契约（宿主只需照做两件事）：
 * - `start()` 幂等；`enabled=false` 或配置无效时**什么都不启动**（不开库、不连模型、不起定时器）。
 * - `stop()` 幂等，且不抛错：宿主退出路径上不该因为派生数据出错而卡住。
 *
 * 故障边界：任何话题级失败（源读取、模型、提交冲突）都只落在该话题的 job 退避上，
 * 不打断同轮其它话题，也不影响聊天主链路（本模块不在消息路径上）。
 */

import {
  resolveTopicSearchConfig,
  topicSearchBlockedReason,
  type ResolvedTopicSearchConfig,
} from './config.js';
import { createTopicEmbedder, type TopicEmbedder, type TopicEmbeddingEndpoint } from './embedding-client.js';
import { createTopicEnricher, type TopicEnricher, type TopicModelEndpoint } from './model-client.js';
import { threadTopicKey } from './identity.js';
import { createTopicScheduler, type TopicRunReport, type TopicScheduler, type TopicTickOutcome } from './scheduler.js';
import { createTopicSearchService, type TopicSearchService } from './search.js';
import type { TopicHistoryReader } from './source.js';
import { openTopicStore, type TopicStore } from './store.js';
import { runEmbeddingBackfill, updateTopicFromSource, type SummaryUpdateLimits } from './summary-updater.js';
import type { Topic } from '../types.js';

export interface TopicRuntimeDeps {
  /** 读取当前配置节（每次用到时读，支持热更新）。 */
  readConfig: () => unknown;
  source: TopicHistoryReader;
  /** 摘要模型连接；由宿主在「配置里引用的模型」可解析时提供。 */
  resolveEnricher?: (config: ResolvedTopicSearchConfig) => TopicEnricher | null;
  /** embedding 连接；关闭时返回 null（不允许初始化客户端）。 */
  resolveEmbedder?: (config: ResolvedTopicSearchConfig) => TopicEmbedder | null;
  store?: TopicStore;
  storePath?: string;
  dataDir?: string;
  now?: () => string;
  owner?: string;
  limits?: Partial<SummaryUpdateLimits>;
  /** 话题入口链接构造（经宿主校验的 URL）；缺省不返回 url。 */
  topicUrl?: (topic: Topic) => string | undefined;
  knownTopicCount?: () => number;
  embeddingBatchSize?: number;
  onReport?: (report: TopicRunReport, slotId: string) => void;
  onError?: (error: unknown, slotId: string) => void;
  /** 测试 seam：替换定时器与时钟。 */
  nowDate?: () => Date;
  scheduler?: Pick<TopicScheduler, 'tick'>;
}

export interface TopicRuntime {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  /** 当前生效配置（含 issues 的关闭态）。 */
  config(): { config: ResolvedTopicSearchConfig; issues: Array<{ code: string; field: string }> };
  /** 手动跑一轮（`botmux topic run` 与测试用）。 */
  runOnce(slotId?: string): Promise<TopicRunReport>;
  tick(at?: Date): Promise<TopicTickOutcome>;
  search: TopicSearchService['search'];
  store?(): TopicStore | undefined;
}

function backoffFilter(store: TopicStore, nowIso: string): (topicKey: string) => boolean {
  return topicKey => {
    const state = store.jobState(topicKey);
    if (!state?.nextAttemptAt) return false;
    return state.nextAttemptAt > nowIso;
  };
}

export function createTopicRuntime(deps: TopicRuntimeDeps): TopicRuntime {
  const now = deps.now ?? (() => new Date().toISOString());
  let store: TopicStore | undefined;
  let scheduler: TopicScheduler | undefined;
  let enricher: TopicEnricher | null = null;
  let embedder: TopicEmbedder | null = null;
  let running = false;

  function ensureStore(): TopicStore {
    if (!store) {
      store = deps.store ?? openTopicStore({ ...(deps.storePath ? { path: deps.storePath } : {}), ...(deps.dataDir ? { dataDir: deps.dataDir } : {}) });
    }
    return store;
  }

  function readConfig(): ReturnType<typeof resolveTopicSearchConfig> {
    return resolveTopicSearchConfig(deps.readConfig());
  }

  function ensureEnricher(config: ResolvedTopicSearchConfig): TopicEnricher | null {
    if (enricher) return enricher;
    enricher = deps.resolveEnricher?.(config) ?? null;
    return enricher;
  }

  function ensureEmbedder(config: ResolvedTopicSearchConfig): TopicEmbedder | null {
    if (embedder) return embedder;
    if (!config.embedding.enabled) return null;
    embedder = deps.resolveEmbedder?.(config) ?? null;
    return embedder;
  }

  async function runOnce(_slotId?: string): Promise<TopicRunReport> {
    const { config } = readConfig();
    // 手动 runOnce 在未启用/前提不满足时必须**报错**：静默返回一份全 0 报告会让人以为
    // 「跑过了、只是没变化」。定时器那条路径自己会先判 enabled，不会撞到这里。
    const blocked = topicSearchBlockedReason(config);
    if (blocked) throw Object.assign(new Error(`topic search not runnable: ${blocked}`), { code: blocked });

    const activeEnricher = ensureEnricher(config);
    if (!activeEnricher) throw Object.assign(new Error('summary model is not configured'), { code: 'no_llm_model_ref' });

    const activeStore = ensureStore();
    const allowedChats = new Set(config.allowedChatIds);
    const entries = (await deps.source.discoverTopics()).filter(entry => allowedChats.has(entry.chatId));

    const nowIso = now();
    const skipUntil = backoffFilter(activeStore, nowIso);
    // 退避中的话题不占本轮预算，否则 maxTopicsPerRun=1 时队首失败项会把其它话题
    // 永久堵死。失败尝试也会更新 job.updatedAt，恢复后按「最久没尝试」排到后面，
    // 不把失败位置当成成功摘要游标。
    const due = entries.filter(entry => !skipUntil(threadTopicKey(entry.chatId, entry.rootMessageId)));
    const budget = Math.max(1, config.maxTopicsPerRun);
    const ordered = due
      .map(entry => {
        const key = threadTopicKey(entry.chatId, entry.rootMessageId);
        const topic = activeStore.getTopic(key);
        const lastChecked = topic?.lastCheckedAt ? Date.parse(topic.lastCheckedAt) : 0;
        const lastAttempt = activeStore.jobState(key)?.updatedAt;
        const lastAttemptMs = lastAttempt ? Date.parse(lastAttempt) : 0;
        const lastTouched = Math.max(
          Number.isNaN(lastChecked) ? 0 : lastChecked,
          Number.isNaN(lastAttemptMs) ? 0 : lastAttemptMs,
        );
        return { entry, lastTouched };
      })
      .sort((a, b) => a.lastTouched - b.lastTouched);

    const report: TopicRunReport = {
      topicsChecked: 0,
      topicsUpdated: 0,
      topicsSkipped: 0,
      topicsFailed: 0,
      pendingEmbeddings: 0,
      truncated: ordered.length > budget,
    };
    const concurrency = Math.max(1, Math.min(config.maxConcurrentTopics, 4));
    const queue = ordered.slice(0, budget);

    const processEntry = async (entry: (typeof queue)[number]['entry']): Promise<void> => {
      report.topicsChecked += 1;
      const outcome = await updateTopicFromSource(
        {
          store: activeStore,
          source: deps.source,
          enricher: activeEnricher,
          now,
          limits: {
            ...(deps.limits ?? {}),
            // 0 表示关闭「缺席即删除」判定，只处理源侧显式 deleted 标记。
            recheckOverlapMs: config.recheckOverlapHours * 60 * 60_000,
          },
        },
        entry,
        { skipUntil },
      );
      if (outcome.status === 'committed') report.topicsUpdated += 1;
      else if (outcome.status === 'no_increment' || outcome.status === 'skipped') report.topicsSkipped += 1;
      else report.topicsFailed += 1;
    };

    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const item = queue[index];
        if (!item) return;
        try {
          await processEntry(item.entry);
        } catch {
          // updateTopicFromSource 内部已把失败落成 job 状态；这里兜住未预期异常，
          // 不让一个话题打死整轮。
          report.topicsFailed += 1;
        }
      }
    });
    await Promise.all(workers);

    const activeEmbedder = ensureEmbedder(config);
    if (activeEmbedder) {
      await runEmbeddingBackfill({
        store: activeStore,
        embedder: activeEmbedder,
        now,
        limit: deps.embeddingBatchSize ?? 20,
      });
      report.pendingEmbeddings = activeStore.pendingEmbeddingTasks(1).length;
    }

    activeStore.pruneSlots(new Date(Date.parse(now()) - 30 * 24 * 60 * 60_000).toISOString());
    return report;
  }

  let searchService: TopicSearchService | undefined;

  function ensureSearch(): TopicSearchService {
    if (!searchService) {
      searchService = createTopicSearchService({
        store: ensureStore(),
        now,
        ...(deps.knownTopicCount ? { knownTopicCount: deps.knownTopicCount } : {}),
        ...(deps.topicUrl ? { topicUrl: deps.topicUrl } : {}),
        embedQuery: async query => {
          const { config } = readConfig();
          if (!config.enabled || !config.embedding.enabled) return null;
          const activeEmbedder = ensureEmbedder(config);
          if (!activeEmbedder) return null;
          const vector = await activeEmbedder.embed(query);
          return { vector, modelKey: activeEmbedder.modelKey };
        },
      });
    }
    return searchService;
  }

  return {
    start() {
      if (running) return;
      const { config, issues } = readConfig();
      if (!config.enabled || issues.length > 0) return;
      if (topicSearchBlockedReason(config)) return;
      if (!deps.scheduler) {
        scheduler = createTopicScheduler({
          store: ensureStore(),
          resolveConfig: () => readConfig().config,
          runOnce,
          ...(deps.nowDate ? { now: deps.nowDate } : {}),
          ...(deps.owner ? { owner: deps.owner } : {}),
          ...(deps.onReport ? { onReport: deps.onReport } : {}),
          ...(deps.onError ? { onError: deps.onError } : {}),
        });
        scheduler.start();
      }
      running = true;
    },
    stop() {
      scheduler?.stop();
      running = false;
    },
    isRunning() {
      return running;
    },
    config() {
      const { config, issues } = readConfig();
      return { config, issues };
    },
    runOnce,
    async tick(at) {
      if (deps.scheduler) return deps.scheduler.tick(at);
      if (!scheduler) {
        return { status: 'disabled' } as TopicTickOutcome;
      }
      return scheduler.tick(at);
    },
    search: (query, caller) => ensureSearch().search(query, caller),
    store: () => store,
  };
}

/** 由配置节构造摘要/向量客户端（宿主在拿到凭证后调用；凭证不进日志）。 */
export function buildTopicClients(config: ResolvedTopicSearchConfig, endpoints: {
  summary?: TopicModelEndpoint | null;
  embedding?: TopicEmbeddingEndpoint | null;
}): { enricher: TopicEnricher | null; embedder: TopicEmbedder | null } {
  if (topicSearchBlockedReason(config)) return { enricher: null, embedder: null };
  return {
    enricher: endpoints.summary ? createTopicEnricher(endpoints.summary) : null,
    embedder: config.embedding.enabled && endpoints.embedding ? createTopicEmbedder(endpoints.embedding) : null,
  };
}
