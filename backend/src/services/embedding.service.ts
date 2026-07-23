import crypto from 'crypto';
import axios from 'axios';
import { config } from '../config';

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

/**
 * Calls the configured real embedding provider (Ollama or OpenAI) to embed
 * a piece of text, mirroring worker/src/embedding_generator.py's
 * Ollama-first, deterministic-fallback strategy so the Node backend and
 * the Python worker behave consistently when asked to embed text at query
 * time (e.g. a chat question in the RAG pipeline). Ingestion-time chunk
 * embeddings are still produced exclusively by the worker; this function
 * exists only for embedding a QUERY (search / chat) from the backend
 * process, where round-tripping through the worker's queue would add
 * unnecessary latency to an interactive request.
 *
 * Falls back to the deterministic `generateEmbedding` above whenever the
 * configured provider is unreachable or misconfigured, so search/chat
 * remain functional (with reduced semantic quality) in local dev/CI
 * environments that don't run Ollama or hold an OpenAI key.
 */
export async function computeEmbedding(text: string): Promise<number[]> {
  try {
    if (config.llmProvider === 'ollama') {
      const res = await axios.post(
        `${config.ollamaHost}/api/embeddings`,
        { model: 'nomic-embed-text', prompt: text },
        { timeout: 15000 }
      );
      const embedding = res.data?.embedding;
      if (Array.isArray(embedding) && embedding.length === EMBEDDING_DIM) {
        return embedding;
      }
    } else if (config.llmProvider === 'openai' && config.openaiApiKey) {
      const res = await axios.post(
        'https://api.openai.com/v1/embeddings',
        { model: 'text-embedding-3-small', input: text, dimensions: EMBEDDING_DIM },
        { headers: { Authorization: `Bearer ${config.openaiApiKey}` }, timeout: 15000 }
      );
      const embedding = res.data?.data?.[0]?.embedding;
      if (Array.isArray(embedding) && embedding.length === EMBEDDING_DIM) {
        return embedding;
      }
    }
  } catch (err) {
    console.warn('Embedding provider call notice/fallback triggered:', err);
  }

  return generateEmbedding(text);
}
