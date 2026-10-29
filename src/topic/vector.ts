/** Vector similarity + RRF fusion (spec §6.1).
 *
 * No external vector engine: cosine over stored vectors of the authorized
 * candidate set. Query and candidate vectors MUST share one modelKey — a
 * different space is skipped, never mixed. Fusion is Reciprocal Rank Fusion
 * over per-channel rankings, keyed by topic.
 */
import type { Topic } from '../types.js';

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** One candidate's vector-channel material: the best-scoring summary vector. */
export interface VectorCandidate {
  topicKey: string;
  summaryId: string;
  similarity: number;
}

/** Rank topics by cosine similarity between the query vector and each
 * summary's stored embedding. Only embeddings whose modelKey matches the
 * query's space participate. */
export function vectorRecall(
  topics: readonly Topic[],
  queryVector: readonly number[],
  queryModelKey: string,
): VectorCandidate[] {
  const candidates: VectorCandidate[] = [];
  for (const topic of topics) {
    let best: VectorCandidate | undefined;
    for (const summary of topic.summaries) {
      const embedding = summary.embedding;
      if (!embedding || embedding.modelKey !== queryModelKey) continue;
      if (embedding.vector.length !== queryVector.length) continue;
      const similarity = cosineSimilarity(queryVector, embedding.vector);
      if (!best || similarity > best.similarity) {
        best = { topicKey: topic.topicKey, summaryId: summary.id, similarity };
      }
    }
    // Sub-zero similarity is noise for this scale; keep ties at 0 out.
    if (best && best.similarity > 0) candidates.push(best);
  }
  return candidates.sort((a, b) => b.similarity - a.similarity || a.topicKey.localeCompare(b.topicKey));
}

const RRF_K = 60;

/** Reciprocal Rank Fusion over keyword and vector rankings (rank 1-based). */
export function fuseRankings(keywordRanked: readonly string[], vectorRanked: readonly string[]): Map<string, number> {
  const fused = new Map<string, number>();
  keywordRanked.forEach((topicKey, index) => {
    fused.set(topicKey, (fused.get(topicKey) ?? 0) + 1 / (RRF_K + index + 1));
  });
  vectorRanked.forEach((topicKey, index) => {
    fused.set(topicKey, (fused.get(topicKey) ?? 0) + 1 / (RRF_K + index + 1));
  });
  return fused;
}
