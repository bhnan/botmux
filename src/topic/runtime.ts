/** Topic-search background runtime — the single deployment-level scheduler
 * owner (spec §2/§5.2). Hosted by the Dashboard central process; started and
 * stopped with its lifecycle (mount point lives in src/dashboard, this module
 * stays dashboard-free and receives every external capability by injection).
 *
 * One tick:
 *   lease → discover authorized topics from session rows (ensure catalog)
 *   → fair scan (bounded topics per run, round-robin cursor)
 *   → per topic: read history window → slice increment → (no increment ⇒
 *     lastCheckedAt only, ZERO model calls) → one structured model call →
 *     revision-CAS commit with cursor
 *   → retry queue (topic summary failures, exponential backoff via jobs)
 *   → embedding jobs (independent of summary success, spec §5.1)
 *   → release lease, persist scan cursor + last run slot.
 *
 * Mid-run disable: the config resolver is consulted at every commit/outbound
 * boundary (before each model call) — stopping the feature halts new model
 * traffic without killing an in-flight HTTP request's bookkeeping.
 */
import { embedSummaryText } from './embedding-client.js';
import { callSummaryModel, type TopicModelCallInput, type TopicModelCallResult } from './model-client.js';
import { topicModelKey, type TopicSearchConfig } from './config.js';
import { topicIdentityFromSessionRow, topicNativeThreadId, type TopicIdentity } from './identity.js';
import { evaluateDueRun, nextSlot, type ScheduleSlot } from './scheduler.js';
import { TopicStore, type TopicJobRecord } from './store.js';
import type { TopicHistoryReader } from './source.js';
import { updateTopicFromWindow, type TopicUpdateOutcome } from './summary-updater.js';

export const SCAN_CURSOR_KEY = 'scan_cursor';
export const LAST_RUN_KEY = 'last_run';
export const DEPLOYMENT_LEASE_SLOT = 'topic-scheduler';
/** How often the (cheap, network-free) due-evaluation loop runs. */
export const EVALUATE_INTERVAL_MS = 30_000;
/** Upper bound for one deployment lease; a crashed holder's lease expires
 * after this and the next tick takes over (spec §5.4). */
export const RUN_LEASE_TTL_MS = 30 * 60_000;
export const EMBEDDING_JOBS_PER_TICK = 20;

export interface TopicSearchRuntimeDeps {
  dataDir: string;
  /** Resolve the effective config; null/undefined = feature disabled now. */
  getConfig: () => TopicSearchConfig | null | undefined;
  /** Dashboard session rows (discovery source). */
  discoverRows: () => Array<Record<string, unknown>>;
  /** Topic history reader (daemon IPC adapter in production). */
  readHistory: TopicHistoryReader;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, 'info' | 'warn'>;
  now?: () => number;
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

export interface TickReport {
  ran: boolean;
  reason?: 'disabled' | 'lease_held' | 'not_due';
  discovered: number;
  topicsProcessed: number;
  committed: number;
  noIncrement: number;
  invalidated: number;
  failed: number;
  retried: number;
  embeddingsProcessed: number;
  embeddingsFailed: number;
  mergedMissedSlots?: number;
}

function emptyReport(ran: boolean, reason?: TickReport['reason']): TickReport {
  return {
    ran, ...(reason ? { reason } : {}),
    discovered: 0, topicsProcessed: 0, committed: 0, noIncrement: 0,
    invalidated: 0, failed: 0, retried: 0, embeddingsProcessed: 0, embeddingsFailed: 0,
  };
}

export class TopicSearchRuntime {
  private readonly deps: TopicSearchRuntimeDeps;
  private readonly store: TopicStore;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private running: Promise<TickReport> | null = null;

  private constructor(deps: TopicSearchRuntimeDeps, store: TopicStore) {
    this.deps = deps;
    this.store = store;
  }

  static async create(deps: TopicSearchRuntimeDeps): Promise<TopicSearchRuntime> {
    const store = await TopicStore.open(deps.dataDir);
    return new TopicSearchRuntime(deps, store);
  }

  get topicStore(): TopicStore { return this.store; }

  private get now(): number { return this.deps.now?.() ?? Date.now(); }
  private get nowIso(): string { return new Date(this.now).toISOString(); }
  private get log(): Pick<Console, 'info' | 'warn'> { return this.deps.logger ?? console; }

  start(): void {
    if (this.stopped) throw new Error('topic_runtime_already_stopped');
    this.scheduleNextEvaluation();
  }

  private scheduleNextEvaluation(): void {
    if (this.stopped) return;
    const timers = this.deps.timers ?? { setTimeout, clearTimeout };
    this.timer = timers.setTimeout.call(undefined, () => {
      void this.evaluateAndTick().finally(() => this.scheduleNextEvaluation());
    }, EVALUATE_INTERVAL_MS);
  }

  private async evaluateAndTick(): Promise<TickReport> {
    const config = this.deps.getConfig();
    if (!config) return emptyReport(false, 'disabled');
    const lastRun = this.store.getScheduleState<{ slotId: string; atMs: number }>(LAST_RUN_KEY);
    const decision = evaluateDueRun(config.schedule, {
      nowMs: this.now,
      lastSlotId: lastRun?.slotId,
      lastLookMs: lastRun?.atMs,
    });
    if (!decision.due) return emptyReport(false, 'not_due');
    const report = await this.tick({ slotId: decision.slotId, mergedMissedSlots: decision.mergedMissedSlots });
    this.store.setScheduleState(LAST_RUN_KEY, { slotId: decision.slotId, atMs: this.now }, this.nowIso);
    return report;
  }

  /** One full pass. Direct calls (manual trigger / tests) bypass slot
   * dedup but still respect the deployment lease. Re-entrant calls join the
   * in-flight run instead of doubling work. */
  async tick(trigger?: { slotId?: string; mergedMissedSlots?: number }): Promise<TickReport> {
    if (this.running) return this.running;
    this.running = this.runOnce(trigger).finally(() => { this.running = null; });
    return this.running;
  }

  private async runOnce(trigger?: { slotId?: string; mergedMissedSlots?: number }): Promise<TickReport> {
    const config = this.deps.getConfig();
    if (!config) return emptyReport(false, 'disabled');
    const lease = this.store.tryAcquireDeploymentLease({
      slotKey: DEPLOYMENT_LEASE_SLOT,
      owner: this.store.owner,
      now: this.nowIso,
      ttlMs: RUN_LEASE_TTL_MS,
    });
    if (!lease.acquired) return emptyReport(false, 'lease_held');
    try {
      const report = emptyReport(true);
      report.mergedMissedSlots = trigger?.mergedMissedSlots;
      this.store.expireLeases(this.nowIso);
      await this.processEmbeddingJobs(config, report);
      await this.processSummaryRetries(config, report);
      this.discoverTopics(config, report);
      const lastProcessed = await this.scanTopics(config, report);
      // Embedding jobs enqueued by this run's commits are processed in the
      // SAME tick (a second pass) — otherwise a daily schedule would defer
      // fresh vectors by a full day.
      await this.processEmbeddingJobs(config, report);
      if (lastProcessed !== undefined) {
        this.store.setScheduleState(SCAN_CURSOR_KEY, { lastTopicKey: lastProcessed }, this.nowIso);
      }
      return report;
    } finally {
      this.store.releaseDeploymentLease(DEPLOYMENT_LEASE_SLOT, this.store.owner, this.nowIso);
    }
  }

  // ─── Discovery ────────────────────────────────────────────────────────────

  /** Merge session-row-derived identities into the persistent catalog.
   * Rows outside the authorized chat scope never mint topics; closed-session
   * topics stay in the catalog by construction (ensure never deletes). */
  private discoverTopics(config: TopicSearchConfig, report: TickReport): void {
    const allowed = new Set(config.allowedChatIds);
    const identities = new Map<string, { identity: TopicIdentity; title: string; nativeThreadId?: string; chatId: string; larkAppId?: string }>();
    for (const row of this.deps.discoverRows()) {
      const identity = topicIdentityFromSessionRow(row);
      if (!identity || !allowed.has(identity.chatId)) continue;
      if (!identities.has(identity.topicKey)) {
        const larkAppId = typeof row.larkAppId === 'string' && row.larkAppId.trim() ? row.larkAppId.trim() : undefined;
        identities.set(identity.topicKey, {
          identity,
          title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : identity.rootMessageId,
          nativeThreadId: topicNativeThreadId(row),
          chatId: identity.chatId,
          larkAppId,
        });
      }
    }
    report.discovered = identities.size;
    for (const entry of identities.values()) {
      try {
        this.store.ensureTopic({
          topicKey: entry.identity.topicKey,
          chatId: entry.identity.chatId,
          rootMessageId: entry.identity.rootMessageId,
          title: entry.title,
          accessPolicyRef: `chat:${entry.chatId}`,
          ...(entry.nativeThreadId ? { nativeThreadId: entry.nativeThreadId } : {}),
          ...(entry.larkAppId ? { sourceLarkAppId: entry.larkAppId } : {}),
        }, this.nowIso);
      } catch (error) {
        this.log.warn(`[topic-search] ensureTopic failed (skipped): ${(error as Error).message}`);
      }
    }
  }

  // ─── Fair scan ────────────────────────────────────────────────────────────

  private currentScanCursor(): string | undefined {
    return this.store.getScheduleState<{ lastTopicKey: string }>(SCAN_CURSOR_KEY)?.lastTopicKey;
  }

  /** Round-robin over the catalog so history topics are not starved by
   * activity-based ordering (spec §5.2 step 3). */
  private orderedTopicKeys(): string[] {
    const keys = this.store.listTopics().map(t => t.topicKey).sort();
    const cursor = this.currentScanCursor();
    if (!cursor) return keys;
    const index = keys.indexOf(cursor);
    if (index < 0) return keys;
    return [...keys.slice(index + 1), ...keys.slice(0, index + 1)];
  }

  /** Returns the LAST topicKey processed this run (undefined = none), which
   * becomes the fair-scan cursor for the next run. */
  private async scanTopics(config: TopicSearchConfig, report: TickReport): Promise<string | undefined> {
    const ordered = this.orderedTopicKeys();
    const firstRunSinceMs = this.now - config.initialLookbackDays * 24 * 60 * 60_000;
    let lastProcessed: string | undefined;
    for (const topicKey of ordered) {
      if (this.stopped || report.topicsProcessed >= config.maxTopicsPerRun) break;
      const topic = this.store.getTopic(topicKey);
      if (!topic) continue;
      if (this.summaryRetryBlocked(topicKey)) continue; // 退避窗口内不重试（也省一次历史读取）
      const outcome = await this.processOneTopic(config, topic, firstRunSinceMs);
      report.topicsProcessed++;
      lastProcessed = topicKey;
      this.tallyOutcome(outcome, report);
    }
    return lastProcessed;
  }

  /** A pending summary-retry job with a future next_attempt_at parks the
   * topic out of the fair scan: the scan must not bypass the failure
   * backoff (spec §5.4 指数退避且有上限). */
  private summaryRetryBlocked(topicKey: string): boolean {
    const job = this.store.getJob(this.summaryRetryJobKey(topicKey));
    if (!job) return false;
    if (job.state !== 'pending' && job.state !== 'failed' && job.state !== 'running') return false;
    return job.nextAttemptAt !== null && Date.parse(job.nextAttemptAt) > this.now;
  }

  private tallyOutcome(outcome: TopicUpdateOutcome, report: TickReport): void {
    switch (outcome.kind) {
      case 'committed': report.committed++; break;
      case 'no_increment': report.noIncrement++; break;
      case 'invalidated': report.invalidated++; break;
      case 'model_failed':
      case 'commit_conflict':
        report.failed++;
        break;
    }
  }

  /** Read + update one topic. Read failures surface as model_failed codes
   * with no store mutation beyond a retry-job enqueue (they must not block
   * other topics, spec §5.4). */
  private async processOneTopic(config: TopicSearchConfig, topic: { topicKey: string; chatId: string; rootMessageId: string; sourceLarkAppId?: string }, firstRunSinceMs: number): Promise<TopicUpdateOutcome> {
    const identity = { topicKey: topic.topicKey, chatId: topic.chatId, rootMessageId: topic.rootMessageId, ...(topic.sourceLarkAppId ? { larkAppId: topic.sourceLarkAppId } : {}) };
    let window;
    try {
      window = await this.deps.readHistory(identity);
    } catch {
      await this.enqueueSummaryRetry(topic.topicKey, 'history_read_failed');
      return { kind: 'model_failed', code: 'history_read_failed' };
    }
    // Disable check at the outbound boundary: no model traffic once off.
    if (!this.deps.getConfig()) return { kind: 'no_increment' };
    const hasStoredCursor = !!this.store.getTopic(topic.topicKey)?.summarizedThroughCursor;
    const outcome = await updateTopicFromWindow(
      { store: this.store, callModel: input => this.callModel(config, input), now: () => this.nowIso },
      { topicKey: topic.topicKey, window },
      {
        embeddingModelKey: config.embedding.enabled ? topicModelKey(config.embedding.model) : undefined,
        ...(hasStoredCursor ? {} : { firstRunSinceMs }),
      },
    );
    if (outcome.kind === 'committed' || outcome.kind === 'no_increment' || outcome.kind === 'invalidated') {
      try { this.store.recordHistoryCheck(topic.topicKey, this.nowIso); } catch { /* topic vanished concurrently */ }
    }
    if (outcome.kind === 'model_failed' || outcome.kind === 'commit_conflict') {
      await this.enqueueSummaryRetry(topic.topicKey, outcome.kind === 'model_failed' ? outcome.code : 'commit_conflict');
    } else {
      this.finishSummaryRetryIfAny(topic.topicKey);
    }
    return outcome;
  }

  private async callModel(config: TopicSearchConfig, input: TopicModelCallInput): Promise<TopicModelCallResult> {
    return callSummaryModel(config.llm, input, { fetchImpl: this.deps.fetchImpl, env: this.deps.env });
  }

  // ─── Summary retry queue ──────────────────────────────────────────────────

  private summaryRetryJobKey(topicKey: string): string {
    return `summary-retry:${topicKey}`;
  }

  private async enqueueSummaryRetry(topicKey: string, code: string): Promise<void> {
    try {
      const { enqueued } = this.store.enqueueJob({
        jobKey: this.summaryRetryJobKey(topicKey),
        kind: 'summary',
        topicKey,
        now: this.nowIso,
      });
      // A fresh job would be claimable immediately; push it one backoff step
      // out so even the first retry waits (spec §5.4 指数退避). An existing
      // job keeps its own backoff state.
      if (enqueued) this.store.finishJob(this.summaryRetryJobKey(topicKey), { ok: false, errorCode: code, now: this.nowIso });
    } catch { /* store failures must not mask the original outcome */ }
  }

  private finishSummaryRetryIfAny(topicKey: string): void {
    const jobKey = this.summaryRetryJobKey(topicKey);
    const job = this.store.getJob(jobKey);
    if (job && job.state !== 'done') {
      try { this.store.finishJob(jobKey, { ok: true, now: this.nowIso }); } catch { /* best effort */ }
    }
  }

  /** Retry failed summaries ahead of the fair scan; bounded per tick. */
  private async processSummaryRetries(config: TopicSearchConfig, report: TickReport): Promise<void> {
    const jobs = this.store.claimDueJobs({
      now: this.nowIso, owner: this.store.owner, leaseTtlMs: RUN_LEASE_TTL_MS, limit: config.maxTopicsPerRun, kinds: ['summary'],
    });
    for (const job of jobs) {
      if (!this.deps.getConfig()) { this.finishClaimed(job, false, 'disabled'); return; }
      const topic = this.store.getTopic(job.topicKey);
      if (!topic) { this.finishClaimed(job, true); continue; }
      const outcome = await this.processOneTopic(config, topic, this.now - config.initialLookbackDays * 24 * 60 * 60_000);
      this.tallyOutcome(outcome, report);
      report.retried++;
      if (outcome.kind === 'model_failed' || outcome.kind === 'commit_conflict') {
        this.finishClaimed(job, false, outcome.kind === 'model_failed' ? outcome.code : 'commit_conflict');
      } else {
        this.finishClaimed(job, true);
      }
    }
  }

  private finishClaimed(job: TopicJobRecord, ok: boolean, code?: string): void {
    try {
      this.store.finishJob(job.jobKey, ok ? { ok: true, now: this.nowIso } : { ok: false, errorCode: code ?? 'unknown', now: this.nowIso });
    } catch { /* best effort bookkeeping */ }
  }

  // ─── Embedding jobs ───────────────────────────────────────────────────────

  private async processEmbeddingJobs(config: TopicSearchConfig, report: TickReport): Promise<void> {
    if (!config.embedding.enabled) return;
    const jobs = this.store.claimDueJobs({
      now: this.nowIso, owner: this.store.owner, leaseTtlMs: RUN_LEASE_TTL_MS, limit: EMBEDDING_JOBS_PER_TICK, kinds: ['embedding'],
    });
    for (const job of jobs) {
      if (!this.deps.getConfig()) { this.finishClaimed(job, false, 'disabled'); return; }
      const payload = job.payload as { summaryId?: string; modelKey?: string; contentHash?: string };
      const topic = this.store.getTopic(job.topicKey);
      const summary = topic?.summaries.find(s => s.id === payload.summaryId);
      if (!topic || !summary) { this.finishClaimed(job, true); continue; } // summary gone: nothing to embed
      const result = await embedSummaryText(
        config.embedding.model,
        summary.text,
        { fetchImpl: this.deps.fetchImpl, env: this.deps.env },
      );
      if (result.ok) {
        const saved = this.store.saveEmbedding({
          topicKey: job.topicKey,
          summaryId: summary.id,
          modelKey: result.modelKey,
          contentHash: payload.contentHash ?? '',
          vector: result.vector,
          now: this.nowIso,
        });
        // content_hash_mismatch = summary changed after job enqueue: the
        // change already enqueued a fresh job — this one is done, not failed.
        this.finishClaimed(job, saved.saved || saved.reason === 'content_hash_mismatch' ? true : false, saved.reason);
        report.embeddingsProcessed++;
      } else {
        this.finishClaimed(job, false, result.code);
        report.embeddingsFailed++;
      }
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Stop the evaluation loop and wait for an in-flight tick (bounded by the
   * lease TTL; the lease self-expires if this process dies). */
  async stop(): Promise<void> {
    this.stopped = true;
    const timers = this.deps.timers ?? { setTimeout, clearTimeout };
    if (this.timer) timers.clearTimeout.call(undefined, this.timer);
    this.timer = null;
    if (this.running) await this.running.catch(() => undefined);
    this.store.close();
  }

  /** Next scheduled fire (diagnostics/verification). */
  nextScheduledSlot(): ScheduleSlot | undefined {
    const config = this.deps.getConfig();
    if (!config) return undefined;
    return nextSlot(config.schedule, this.now);
  }
}
