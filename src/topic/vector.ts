/**
 * 向量相关纯计算：向量校验、余弦相似度、名次融合（RRF）。
 *
 * 首版**不引入向量数据库**：候选集已被授权范围限制为「当前部署已知话题」，精确
 * 计算即可。接口按「打分」设计，将来换 ANN 索引不需要改调用方。
 *
 * 两条容易踩的语义：
 * - 不同 `modelKey`（provider/model/revision/dimensions）的向量不可比较，维度不同
 *   直接判为不可比（返回 null），不做截断/补零。
 * - 关键词分与向量分**不相加**（量纲不同），只按名次做 RRF 融合。
 */

import { createHash } from 'node:crypto';

export type EmbeddingVectorIssue = 'not_array' | 'dims_mismatch' | 'non_finite' | 'zero_norm';

export interface EmbeddingVectorValidation {
  ok: boolean;
  issue?: EmbeddingVectorIssue;
}

/** 校验一个待存储/待比较的向量。`dimensions` 已知时必须严格相等。 */
export function validateEmbeddingVector(vector: unknown, dimensions?: number): EmbeddingVectorValidation {
  if (!Array.isArray(vector)) return { ok: false, issue: 'not_array' };
  if (dimensions !== undefined && vector.length !== dimensions) {
    return { ok: false, issue: 'dims_mismatch' };
  }
  if (vector.length === 0) return { ok: false, issue: 'zero_norm' };
  let squared = 0;
  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, issue: 'non_finite' };
    squared += value * value;
  }
  if (!(squared > 0)) return { ok: false, issue: 'zero_norm' };
  return { ok: true };
}

/** 余弦相似度；维度不一致或零向量返回 null（不可比，不伪造 0）。 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (!(normA > 0) || !(normB > 0)) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface RankedKey {
  key: string;
  score: number;
}

/** RRF 常数：Cormack 等人给出的经验值，压制头部名次差距、放大「多路都召回」。 */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion：输入若干「已按相关性降序排列」的名次表，输出 key → 融合分。
 * 只用名次，不用原始分数——关键词分与余弦分不可相加。
 */
export function reciprocalRankFusion(
  lists: ReadonlyArray<ReadonlyArray<RankedKey>>,
  options: { k?: number } = {},
): Map<string, number> {
  const k = options.k ?? RRF_K;
  const fused = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const contribution = 1 / (k + index + 1);
      fused.set(item.key, (fused.get(item.key) ?? 0) + contribution);
    });
  }
  return fused;
}

/** 摘要正文的内容哈希：正文变化即让旧向量失效（见 TopicSummaryEmbedding.contentHash）。 */
export function summaryContentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
