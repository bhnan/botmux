import type { DatabaseSyncLike } from '../services/sqlite-compat.js';
import type { Topic, TopicSummary } from '../types.js';
import type { TopicLease } from './jobs.js';
import type { TopicModelProfile, TopicSearchConfig } from './config.js';
import { TopicModelClient, topicModelKey } from './model-client.js';
import { createHash } from 'node:crypto';

const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
export const TOPIC_EMBEDDING_SCHEMA = `CREATE TABLE IF NOT EXISTS topic_embedding_jobs (
  topic TEXT NOT NULL, summary TEXT NOT NULL, model TEXT NOT NULL, hash TEXT NOT NULL, profile TEXT NOT NULL,
  owner TEXT, epoch INTEGER, attempt INTEGER NOT NULL DEFAULT 0, nextRetry INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL, error TEXT, PRIMARY KEY(topic, summary)
);`;
interface EmbeddingRow {
  topic: string; summary: string; model: string; hash: string; profile: string;
  owner: string | null; epoch: number | null; attempt: number; nextRetry: number; state: string;
}
export interface TopicEmbeddingClaim extends EmbeddingRow { lease: TopicLease; text: string }

/** Durable per-summary tasks. Source-reading allowlists intentionally do not filter retained summaries. */
export class TopicEmbeddingQueue {
  constructor(
    private readonly db: DatabaseSyncLike,
    private readonly transaction: <T>(action: () => T) => T,
    private readonly read: (key: string) => Topic | null,
    private readonly write: (topic: Topic) => void,
    private readonly validLease: (lease: TopicLease) => boolean,
    private readonly clock: () => number,
  ) {}

  /** Invoked within the summary transaction; only text/hash/model differences create work. */
  enqueueInsideTransaction(topic: Topic, profile: TopicModelProfile): number {
    const model = topicModelKey(profile); let count = 0;
    for (const summary of topic.summaries) {
      const hash = hashText(summary.text);
      if (summary.embedding?.contentHash === hash && summary.embedding.modelKey === model) continue;
      const previous = this.db.prepare('SELECT * FROM topic_embedding_jobs WHERE topic=? AND summary=?').get(topic.topicKey, summary.id) as EmbeddingRow | undefined;
      if (previous?.model === model && previous.hash === hash) continue;
      this.db.prepare(`INSERT INTO topic_embedding_jobs (topic, summary, model, hash, profile, state) VALUES (?, ?, ?, ?, ?, 'queued')
        ON CONFLICT(topic, summary) DO UPDATE SET model=excluded.model, hash=excluded.hash, profile=excluded.profile, state='queued', owner=NULL, epoch=NULL, attempt=0, nextRetry=0, error=NULL`)
        .run(topic.topicKey, summary.id, model, hash, JSON.stringify(profile));
      count++;
    }
    return count;
  }

  reindex(lease: TopicLease, topics: readonly Topic[], profile: TopicModelProfile): number {
    return this.transaction(() => {
      if (!this.validLease(lease)) throw new Error('stale_topic_embedding_claim');
      let count = 0;
      for (const topic of topics) {
        // Caller snapshots may predate a deletion/text update. Read current content under this lock.
        const current = this.read(topic.topicKey);
        if (current) count += this.enqueueInsideTransaction(current, profile);
      }
      return count;
    });
  }

  claim(lease: TopicLease): TopicEmbeddingClaim | null {
    return this.transaction(() => {
      if (!this.validLease(lease)) return null;
      const rows = this.db.prepare("SELECT * FROM topic_embedding_jobs WHERE nextRetry<=? AND (state='queued' OR (state='running' AND (owner<>? OR epoch<>?))) ORDER BY nextRetry, topic, summary LIMIT 100")
        .all(this.clock(), lease.owner, lease.epoch) as EmbeddingRow[];
      for (const row of rows) {
        const summary = this.read(row.topic)?.summaries.find(item => item.id === row.summary);
        if (!summary || hashText(summary.text) !== row.hash) {
          this.db.prepare('DELETE FROM topic_embedding_jobs WHERE topic=? AND summary=?').run(row.topic, row.summary); continue;
        }
        this.db.prepare("UPDATE topic_embedding_jobs SET state='running', owner=?, epoch=?, attempt=attempt+1 WHERE topic=? AND summary=?")
          .run(lease.owner, lease.epoch, row.topic, row.summary);
        return { ...row, lease: { ...lease }, owner: lease.owner, epoch: lease.epoch, attempt: row.attempt + 1, state: 'running', text: summary.text };
      }
      return null;
    });
  }

  private assert(claim: TopicEmbeddingClaim): void {
    if (!this.validLease(claim.lease) || !this.db.prepare("SELECT 1 FROM topic_embedding_jobs WHERE topic=? AND summary=? AND model=? AND hash=? AND owner=? AND epoch=? AND attempt=? AND state='running'")
      .get(claim.topic, claim.summary, claim.model, claim.hash, claim.lease.owner, claim.lease.epoch, claim.attempt)) throw new Error('stale_topic_embedding_claim');
  }

  complete(claim: TopicEmbeddingClaim, vector: number[], currentModel: string | null): boolean {
    return this.transaction(() => {
      this.assert(claim);
      const topic = this.read(claim.topic);
      const summary = topic?.summaries.find(item => item.id === claim.summary);
      if (currentModel !== claim.model || !topic || !summary || hashText(summary.text) !== claim.hash) {
        this.db.prepare('DELETE FROM topic_embedding_jobs WHERE topic=? AND summary=?').run(claim.topic, claim.summary); return false;
      }
      const profile = JSON.parse(claim.profile) as TopicModelProfile;
      if (!validVector(vector, profile.dimensions ?? 0)) throw new Error('invalid_topic_embedding');
      summary.embedding = { modelKey: claim.model, contentHash: claim.hash, vector };
      this.write(topic);
      this.db.prepare("UPDATE topic_embedding_jobs SET state='done', error=NULL WHERE topic=? AND summary=?").run(claim.topic, claim.summary);
      return true;
    });
  }

  fail(claim: TopicEmbeddingClaim): void {
    this.transaction(() => {
      this.assert(claim);
      this.db.prepare("UPDATE topic_embedding_jobs SET state='queued', nextRetry=?, error='topic_embedding_failed' WHERE topic=? AND summary=?")
        .run(this.clock() + Math.min(1000 * 2 ** Math.min(claim.attempt, 12), 3_600_000), claim.topic, claim.summary);
    });
  }

  pause(claim: TopicEmbeddingClaim): void {
    this.transaction(() => {
      this.assert(claim);
      this.db.prepare("UPDATE topic_embedding_jobs SET state='queued' WHERE topic=? AND summary=?").run(claim.topic, claim.summary);
    });
  }

  pending(): number { return Number((this.db.prepare("SELECT COUNT(*) AS n FROM topic_embedding_jobs WHERE state<>'done'").get() as { n: number }).n); }
}

export function validVector(vector: readonly number[], dimensions: number): boolean {
  return dimensions > 0 && vector.length === dimensions && vector.every(value => typeof value === 'number' && Number.isFinite(value)) && vector.some(value => value !== 0);
}
export function summaryVector(summary: TopicSummary, modelKey: string, dimensions: number): number[] | null {
  const vector = summary.embedding;
  return vector?.modelKey === modelKey && vector.contentHash === hashText(summary.text) && validVector(vector.vector, dimensions) ? vector.vector : null;
}
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || !validVector(a, a.length) || !validVector(b, b.length)) return 0;
  // Scale first: large but finite provider coordinates must not overflow dot/norm arithmetic.
  const scaleA = Math.max(...a.map(Math.abs)), scaleB = Math.max(...b.map(Math.abs));
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] / scaleA, y = b[i] / scaleB; dot += x * y; normA += x * x; normB += y * y; }
  return dot / Math.sqrt(normA * normB);
}

export class TopicEmbeddingWorker {
  private active: Promise<void> | null = null;
  private abort: AbortController | null = null;
  constructor(private readonly queue: TopicEmbeddingQueue, private readonly model: Pick<TopicModelClient, 'embed'>, private readonly config: () => TopicSearchConfig) {}

  tick(lease: TopicLease): void {
    if (this.active || !this.config().embedding.enabled) return;
    const claim = this.queue.claim(lease);
    if (!claim) return;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.active = (async () => {
      try {
        const before = this.config();
        if (!before.embedding.enabled) { this.queue.pause(claim); return; }
        const authorized = before.embedding.modelRef ? before.models[before.embedding.modelRef] : undefined;
        if (!authorized || topicModelKey(authorized) !== claim.model) {
          this.queue.complete(claim, [], authorized ? topicModelKey(authorized) : null); return;
        }
        const vector = await this.model.embed(JSON.parse(claim.profile), claim.text, signal);
        signal.throwIfAborted();
        const config = this.config();
        const current = config.embedding.modelRef ? config.models[config.embedding.modelRef] : undefined;
        this.queue.complete(claim, vector, current ? topicModelKey(current) : null);
      } catch {
        // Old ownership, changed text/model and shutdown can all invalidate this attempt.
        try { this.queue.fail(claim); } catch { /* fenced; next owner recovers */ }
      }
    })().finally(() => { this.active = null; this.abort = null; });
  }

  async idle(): Promise<void> { await this.active; }
  async close(): Promise<void> { this.abort?.abort(); await this.idle(); }
}
