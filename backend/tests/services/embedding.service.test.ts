import { describe, it, expect } from 'vitest';
import { generateEmbedding } from '../../src/services/embedding.service';

describe('embedding.service', () => {
  it('generates a fixed-length numeric vector', () => {
    const embedding = generateEmbedding('invoice from Dell Technologies for server hardware');
    expect(embedding).toHaveLength(768);
    embedding.forEach((v) => expect(typeof v).toBe('number'));
  });

  it('is deterministic: the same text always produces the same vector', () => {
    const text = 'Steuerbescheid 2024 Finanzamt München';
    expect(generateEmbedding(text)).toEqual(generateEmbedding(text));
  });

  it('produces different vectors for different text', () => {
    const a = generateEmbedding('Rechnung Stromkosten');
    const b = generateEmbedding('Mietvertrag Wohnung');
    expect(a).not.toEqual(b);
  });

  it('is a unit vector (L2 norm ~1), so cosine similarity behaves sensibly', () => {
    const embedding = generateEmbedding('test document text');
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});
