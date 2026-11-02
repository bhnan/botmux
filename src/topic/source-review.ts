import type { DatabaseSyncLike } from '../services/sqlite-compat.js';
import type { TopicClaim } from './jobs.js';
import type { TopicSearchConfig } from './config.js';
import type { TopicMessage } from './source.js';

export type TopicSourceCheck = { state: 'present'; message: TopicMessage } | { state: 'deleted' } | { state: 'unknown' };
export interface TopicReviewCandidate { topic: string; message: string; created: string; kind: 'recent' | 'historical' }
export const TOPIC_REVIEW_SCHEMA = `
  CREATE TABLE IF NOT EXISTS topic_review_batches (batch TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS topic_reviews (batch TEXT NOT NULL, topic TEXT NOT NULL, message TEXT NOT NULL, created TEXT NOT NULL, kind TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(batch, topic, message));
  CREATE TABLE IF NOT EXISTS topic_review_attempts (topic TEXT NOT NULL, message TEXT NOT NULL, attempted INTEGER NOT NULL, PRIMARY KEY(topic, message));
`;

/** Shared batch budget, not a fresh historical budget for every topic/retry/continuation.
 * Only sources referenced by retained summaries qualify. Source fingerprints contain no raw text.
 */
export class TopicSourceReviewQueue {
  constructor(private readonly db: DatabaseSyncLike, private readonly transaction: <T>(action: () => T) => T, private readonly assertClaim: (claim: TopicClaim) => void) {}

  pending(claim: TopicClaim, config: TopicSearchConfig): TopicReviewCandidate[] {
    return this.transaction(() => {
      this.assertClaim(claim);
      if (!this.db.prepare('SELECT 1 FROM topic_review_batches WHERE batch=?').get(claim.job.batch)) {
        const now = claim.job.acceptedAt, recentSince = new Date(now - config.overlapHours * 3_600_000).toISOString();
        const historicalBefore = new Date(now - config.historicalRecheckDays * 86_400_000).toISOString();
        // json_each reads the authoritative references, so edits/expiry never leave dangling review
        // eligibility. Order by last attempt first; failing references cannot monopolize later runs.
        const eligible = `SELECT DISTINCT f.topic, f.message, f.created, f.checked, COALESCE(a.attempted, 0) AS attempted
          FROM topic_jobs j JOIN topic_documents d ON d.key=j.topicKey
          JOIN json_each(d.body, '$.summaries') s JOIN json_each(s.value, '$.sourceMessageIds') r
          JOIN topic_source_fingerprints f ON f.topic=d.key AND f.message=r.value
          LEFT JOIN topic_review_attempts a ON a.topic=f.topic AND a.message=f.message
          WHERE j.batch=? AND COALESCE(a.attempted, 0)<?`;
        const recent = this.db.prepare(`SELECT topic, message, created FROM (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY topic ORDER BY attempted, checked, message) AS n FROM (${eligible}) WHERE created>=?
        ) WHERE n<=?`).all(claim.job.batch, now - 3_600_000, recentSince, Math.min(10, config.maxMessagesPerBatch)) as Omit<TopicReviewCandidate, 'kind'>[];
        const historical = this.db.prepare(`SELECT topic, message, created FROM (${eligible}) WHERE created<? AND checked<=? ORDER BY attempted, checked, topic, message LIMIT ?`)
          .all(claim.job.batch, now - 3_600_000, recentSince, historicalBefore, config.maxHistoricalChecksPerRun) as Omit<TopicReviewCandidate, 'kind'>[];
        for (const candidate of [...recent.map(row => ({ ...row, kind: 'recent' })), ...historical.map(row => ({ ...row, kind: 'historical' }))]) {
          this.db.prepare('INSERT INTO topic_reviews (batch, topic, message, created, kind) VALUES (?, ?, ?, ?, ?)').run(claim.job.batch, candidate.topic, candidate.message, candidate.created, candidate.kind);
          // Reserve before I/O: a crash can defer a check by one hour, never duplicate unbounded I/O.
          this.db.prepare('INSERT INTO topic_review_attempts VALUES (?, ?, ?) ON CONFLICT(topic, message) DO UPDATE SET attempted=excluded.attempted').run(candidate.topic, candidate.message, now);
        }
        this.db.prepare('INSERT INTO topic_review_batches VALUES (?)').run(claim.job.batch);
      }
      return this.db.prepare('SELECT topic, message, created, kind FROM topic_reviews WHERE batch=? AND topic=? AND done=0 ORDER BY kind, message').all(claim.job.batch, claim.job.topicKey) as TopicReviewCandidate[];
    });
  }

  finish(claim: TopicClaim, candidate: TopicReviewCandidate): void {
    this.transaction(() => {
      this.assertClaim(claim);
      if (candidate.topic !== claim.job.topicKey) throw new Error('topic_review_scope_mismatch');
      this.db.prepare('UPDATE topic_reviews SET done=1 WHERE batch=? AND topic=? AND message=?').run(claim.job.batch, candidate.topic, candidate.message);
    });
  }
}
