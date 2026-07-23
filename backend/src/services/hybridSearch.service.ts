const DEFAULT_K = 60; // standard RRF smoothing constant

export interface FusedResult {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion: combines multiple ranked result lists (e.g.
 * keyword full-text search + vector cosine-similarity search) into one
 * ranking, without needing the lists' raw scores to be comparable.
 *
 * score(doc) = sum over lists containing doc of 1 / (k + rank_in_list)
 *
 * The result is sorted descending by fused score and score is normalized
 * to (0, 1] by dividing by the maximum possible score (one appearance at
 * rank 0 in every list), giving callers a stable "confidence" number.
 */
export function reciprocalRankFusion(resultLists: string[][], k: number = DEFAULT_K): FusedResult[] {
  const scores = new Map<string, number>();

  for (const list of resultLists) {
    list.forEach((id, rank) => {
      const contribution = 1 / (k + rank + 1);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
    });
  }

  if (scores.size === 0) return [];

  const maxPossibleScore = resultLists.length * (1 / (k + 1));

  return Array.from(scores.entries())
    .map(([id, rawScore]) => ({ id, score: rawScore / maxPossibleScore }))
    .sort((a, b) => b.score - a.score);
}
