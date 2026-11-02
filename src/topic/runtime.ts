import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Topic } from '../types.js';
import { TopicStore } from './store.js';
import { TopicModelClient } from './model-client.js';
import { TopicScheduler } from './scheduler.js';
import { TopicEmbeddingWorker } from './embedding.js';
import { topicSummaryExecutor } from './summary-updater.js';
import { topicIdentity, sessionTopicKey } from './identity.js';
import { parseTopicSearchConfig, topicScheduleSlot, type TopicSearchConfig } from './config.js';
import { TopicSearchService, TopicSearchError } from './search.js';
import type { TopicPageReader, TopicSourcePage } from './source.js';

export interface TopicRuntimeDeps {
  directory: string;
  config: () => TopicSearchConfig;
  sessions: () => Array<Record<string, unknown>>;
  daemons: () => Array<{ larkAppId: string }>;
  proxy: (appId: string, path: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  model?: TopicModelClient;
  source?: (topic: Topic) => TopicPageReader;
}

/** One logical deployment scheduler in Dashboard, with no web-tab or message-main-path dependency. */
export class TopicRuntime {
  private store: TopicStore | null = null;
  private scheduler: TopicScheduler | null = null;
  private embedding: TopicEmbeddingWorker | null = null;
  private searchService: TopicSearchService | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly model: TopicModelClient;
  private readonly now: () => number;
  private lastDiscovery = -Infinity;
  lastError: string | null = null;
  constructor(private readonly deps: TopicRuntimeDeps) { this.model = deps.model ?? new TopicModelClient(); this.now = deps.now ?? Date.now; }

  private initialize(): void {
    if (this.store) return;
    this.store = new TopicStore(join(this.deps.directory, 'topics.sqlite'), this.now);
    const config = () => this.deps.config();
    const executor = topicSummaryExecutor({ store: this.store, model: this.model, now: this.now, source: topic => this.deps.source?.(topic) ?? this.reader(topic) });
    this.scheduler = new TopicScheduler(this.store, () => {
      const current = config();
      return { ...current, slot: topicScheduleSlot(current.schedule, this.now()), snapshot: JSON.stringify(current) };
    }, executor);
    this.embedding = new TopicEmbeddingWorker(this.store.embeddings, this.model, config);
    this.searchService = new TopicSearchService(this.store, config, this.model, { now: this.now });
  }

  private reader(topic: Topic): TopicPageReader {
    let boundApp = this.store?.sourceCheckpoint(topic.topicKey)?.sourceId;
    return async (token, signal) => {
      const online = this.deps.daemons().map(daemon => daemon.larkAppId);
      const preferred = this.deps.sessions().filter(row => sessionTopicKey(row) === topic.topicKey).map(row => row.larkAppId).filter((id): id is string => typeof id === 'string');
      const candidates = (boundApp ? [boundApp] : [...new Set([...preferred, ...online])]).filter(id => online.includes(id));
      for (const appId of candidates) {
        signal.throwIfAborted();
        if (!this.deps.config().allowedChatIds.includes(topic.chatId)) throw new Error('topic_scope_removed');
        try {
          const response = await this.deps.proxy(appId, '/api/topic-source/page', {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal,
            body: JSON.stringify({ chatId: topic.chatId, rootMessageId: topic.rootMessageId, ...(topic.nativeThreadId ? { nativeThreadId: topic.nativeThreadId } : {}), ...(token ? { token } : {}) }),
          });
          if (!response.ok) { await response.body?.cancel(); continue; }
          const page = await response.json() as TopicSourcePage;
          boundApp = appId;
          return { ...page, sourceId: appId };
        } catch { signal.throwIfAborted(); }
      }
      throw new Error('topic_source_unavailable');
    };
  }

  tick(): void {
    if (this.stopped) return;
    try {
      const config = this.deps.config();
      if (!this.store && !config.enabled && !existsSync(join(this.deps.directory, 'topics.sqlite'))) return;
      this.initialize();
      if (config.enabled && this.now() - this.lastDiscovery >= 15_000) {
        const rows = [...this.deps.sessions()].sort((a, b) => Number(a.spawnedAt ?? 0) - Number(b.spawnedAt ?? 0));
        const seen = new Set<string>();
        for (const row of rows) {
          const identity = topicIdentity(row);
          if (!identity || seen.has(identity.topicKey) || !config.allowedChatIds.includes(identity.chatId)) continue;
          seen.add(identity.topicKey);
          this.store!.discover({ chatId: identity.chatId, rootMessageId: identity.rootMessageId,
            title: typeof row.title === 'string' && row.title.trim() ? row.title : identity.rootMessageId,
            larkThreadId: identity.nativeThreadId, accessPolicyRef: 'dashboard-sensitive-history' }, new Date(this.now()).toISOString());
        }
        this.lastDiscovery = this.now();
      }
      this.scheduler!.tick();
      const lease = this.scheduler!.currentLease();
      if (lease) {
        if (config.retentionDays !== null) {
          const page = this.store!.maintenancePage(lease, 'retention');
          this.store!.expireSummaries(lease, page.map(topic => topic.topicKey), config.retentionDays, new Date(this.now()).toISOString());
        }
        if (config.enabled && config.embedding.enabled && config.embedding.modelRef) {
          const topics = this.store!.maintenancePage(lease, 'embedding');
          this.store!.embeddings.reindex(lease, topics, config.models[config.embedding.modelRef]);
        }
        this.embedding!.tick(lease);
      }
      this.lastError = this.scheduler!.lastError;
    } catch { this.lastError = 'topic_runtime_failed'; }
  }

  start(): void { if (!this.timer && !this.stopped) { this.tick(); this.timer = setInterval(() => this.tick(), 2000); this.timer.unref(); } }
  service(): TopicSearchService {
    if (!this.deps.config().enabled) throw new TopicSearchError(403, 'topic_search_disabled');
    if (this.stopped) throw new TopicSearchError(503, 'topic_search_unavailable');
    this.initialize(); return this.searchService!;
  }
  status(): { enabled: boolean; pendingJobs: number; pendingEmbeddings: number; error: string | null } {
    return { enabled: this.deps.config().enabled, pendingJobs: this.store?.jobs.list().filter(job => job.state === 'queued' || job.state === 'running').length ?? 0, pendingEmbeddings: this.store?.embeddings.pending() ?? 0, error: this.lastError };
  }
  async idle(): Promise<void> { await this.scheduler?.idle(); await this.embedding?.idle(); }
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null;
    await Promise.all([this.scheduler?.close(), this.embedding?.close()]); this.store?.close(); this.store = null;
  }
}

export function disabledTopicSearchConfig(): TopicSearchConfig { return parseTopicSearchConfig(); }
