# Ticket #10: [Performance] OCR Worker Scaling & GPU Acceleration

## Type
`performance`, `infrastructure`

## Description
High-volume document processing requires horizontal scaling of Python OCR workers and optional GPU acceleration for local LLM metadata extraction.

## Acceptance Criteria
- [ ] Support dynamic scaling of worker replicas in `docker-compose.yml` (`docker compose scale worker=4`).
- [ ] Add NVIDIA CUDA container runtime support for Tesseract & Ollama GPU acceleration.
- [ ] Prometheus metrics endpoint exposing queue length, processing latency per page, and failure rate.
- [ ] Benchmarking report validating ingestion speed of > 100 pages per minute across 4 worker replicas.
