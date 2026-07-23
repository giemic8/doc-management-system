import os
import re
import hashlib
import requests

EMBEDDING_DIM = 768


def chunk_text(text: str, chunk_size: int = 500, overlap: int = 50) -> list:
    """Splits text into overlapping word-based chunks for embedding."""
    if not text or not text.strip():
        return []
    words = text.split()
    if len(words) <= chunk_size:
        return [text.strip()]

    chunks = []
    start = 0
    while start < len(words):
        end = min(start + chunk_size, len(words))
        chunks.append(" ".join(words[start:end]))
        if end == len(words):
            break
        start = end - overlap
    return chunks


def _deterministic_fallback_embedding(text: str) -> list:
    """
    Dependency-free deterministic embedding, mirroring the Node backend's
    fallback (see backend/src/services/embedding.service.ts) for consistency
    between the two embedding call sites. NOT semantically meaningful the
    way a trained model's embedding is -- used only when no real embedding
    provider (Ollama / OpenAI) is reachable.
    """
    vector = [0.0] * EMBEDDING_DIM
    normalized = text.lower().strip()
    ngram_size = 3

    for i in range(max(0, len(normalized) - ngram_size + 1)):
        ngram = normalized[i:i + ngram_size]
        digest = hashlib.sha256(ngram.encode("utf-8")).digest()
        for d in range(EMBEDDING_DIM):
            byte = digest[d % len(digest)]
            vector[d] += (byte / 255.0) * 2 - 1

    norm = sum(v * v for v in vector) ** 0.5
    if norm == 0:
        return vector
    return [v / norm for v in vector]


class EmbeddingGenerator:
    def __init__(self):
        self.provider = os.getenv("LLM_PROVIDER", "ollama")
        self.ollama_host = os.getenv("OLLAMA_HOST", "http://localhost:11434")

    def generate(self, text: str) -> list:
        """Generates a 768-dim embedding, preferring Ollama's embeddings API
        and falling back to a deterministic local embedding if the provider
        is unreachable (e.g. no GPU/model infra available)."""
        if self.provider == "ollama":
            try:
                res = requests.post(
                    f"{self.ollama_host}/api/embeddings",
                    json={"model": "nomic-embed-text", "prompt": text},
                    timeout=15,
                )
                if res.status_code == 200:
                    embedding = res.json().get("embedding")
                    if embedding and len(embedding) == EMBEDDING_DIM:
                        return embedding
            except Exception as err:
                print(f"Embedding provider call notice/fallback triggered: {err}")

        return _deterministic_fallback_embedding(text)
