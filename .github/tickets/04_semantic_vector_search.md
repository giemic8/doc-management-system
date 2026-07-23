# Ticket #4: [AI / Feature] Hybrid Semantic Vector Search (RAG / pgvector)

## Type
`ai`, `search`

## Description
Extend the current text search with semantically aware vector search using PostgreSQL `pgvector` embeddings, enabling queries like "Where is my tax assessment from 2024?" even if exact keywords differ.

## Acceptance Criteria
- [ ] Python Worker generates text embeddings for chunks of OCR text using SentenceTransformers or Ollama embeddings API.
- [ ] Store 768/1536-dimensional vectors in PostgreSQL `pgvector` column.
- [ ] Implement Reciprocal Rank Fusion (RRF) combining keyword FTS search + cosine similarity vector search.
- [ ] Return match confidence score and highlighted relevant text snippet in search results.
