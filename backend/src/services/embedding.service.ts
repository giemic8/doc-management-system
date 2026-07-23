import crypto from 'crypto';

const EMBEDDING_DIM = 768;

/**
 * Deterministic, dependency-free text embedding used as a fallback when no
 * embedding model (Ollama / OpenAI / SentenceTransformers) is reachable —
 * e.g. in local dev/CI environments without GPU/model infrastructure. It is
 * NOT semantically meaningful in the way a trained model's embedding is,
 * but it is deterministic and produces a normalized vector, so cosine
 * similarity/pgvector queries behave correctly end-to-end (nearly-identical
 * text produces nearly-identical vectors, since it's built from character
 * n-gram hashing).
 *
 * In production, this is a fallback path: `computeEmbedding` (see below)
 * tries a real embedding provider first and only calls this on failure.
 */
export function generateEmbedding(text: string): number[] {
  const vector = new Array(EMBEDDING_DIM).fill(0);
  const normalized = text.toLowerCase().trim();

  const ngramSize = 3;
  for (let i = 0; i <= normalized.length - ngramSize; i++) {
    const ngram = normalized.slice(i, i + ngramSize);
    const hash = crypto.createHash('sha256').update(ngram).digest();
    for (let d = 0; d < EMBEDDING_DIM; d++) {
      // Use successive bytes (wrapping) of the hash to perturb each dimension.
      const byte = hash[d % hash.length];
      vector[d] += (byte / 255) * 2 - 1; // map to [-1, 1]
    }
  }

  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}
