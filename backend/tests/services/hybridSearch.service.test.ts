import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion } from '../../src/services/hybridSearch.service';

describe('reciprocalRankFusion', () => {
  it('ranks an item appearing near the top of both lists highest', () => {
    const keywordResults = ['doc-a', 'doc-b', 'doc-c'];
    const vectorResults = ['doc-a', 'doc-c', 'doc-b'];

    const fused = reciprocalRankFusion([keywordResults, vectorResults]);

    expect(fused[0].id).toBe('doc-a');
  });

  it('gives credit to an item found by only one of the two lists', () => {
    const keywordResults = ['doc-a', 'doc-b'];
    const vectorResults = ['doc-c'];

    const fused = reciprocalRankFusion([keywordResults, vectorResults]);
    const ids = fused.map((f) => f.id);

    expect(ids).toContain('doc-a');
    expect(ids).toContain('doc-b');
    expect(ids).toContain('doc-c');
  });

  it('ranks an item found by both lists above one found by only one list', () => {
    const keywordResults = ['doc-a', 'doc-b'];
    const vectorResults = ['doc-b', 'doc-z'];

    const fused = reciprocalRankFusion([keywordResults, vectorResults]);

    // doc-b appears in both lists (rank 2 and rank 1), doc-a and doc-z each
    // appear in only one list -- doc-b should outrank both.
    const rankOf = (id: string) => fused.findIndex((f) => f.id === id);
    expect(rankOf('doc-b')).toBeLessThan(rankOf('doc-a'));
    expect(rankOf('doc-b')).toBeLessThan(rankOf('doc-z'));
  });

  it('returns a normalized confidence score between 0 and 1', () => {
    const fused = reciprocalRankFusion([['doc-a', 'doc-b'], ['doc-a']]);
    fused.forEach((f) => {
      expect(f.score).toBeGreaterThan(0);
      expect(f.score).toBeLessThanOrEqual(1);
    });
  });

  it('handles empty lists gracefully', () => {
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });
});
