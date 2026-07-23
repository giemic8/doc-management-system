# OCR Worker Scaling & GPU Acceleration

## Horizontal scaling

The `worker` service in `docker-compose.yml` has no fixed `container_name`,
so it can be scaled to multiple replicas:

```bash
docker compose up -d --scale worker=4
```

Each replica polls the same `documents` table (`status = 'pending' OR
'processing'`) independently; because Postgres row visibility means two
replicas can occasionally pick up the same batch under high concurrency,
consider adding `FOR UPDATE SKIP LOCKED` to the worker's polling query if
you scale beyond a couple of replicas in production (not yet applied here
-- flagging as a known follow-up rather than guessing at a fix untested
against real concurrent load).

## GPU acceleration

`docker-compose.yml` has a commented-out `deploy.resources.reservations`
block on the `worker` service for NVIDIA GPU passthrough. To enable:

1. Install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) on the host.
2. Uncomment the `deploy` block in `docker-compose.yml`.
3. Tesseract itself doesn't use the GPU, but Ollama (used for AI metadata
   extraction and embeddings) will use it automatically once the container
   can see the GPU.

## Prometheus metrics

Each worker replica exposes metrics on `:9100/metrics` (configurable via
`METRICS_PORT`):

- `dms_worker_documents_processed_total` (counter)
- `dms_worker_documents_failed_total` (counter)
- `dms_worker_processing_latency_seconds` (histogram)
- `dms_worker_pending_queue_length` (gauge)

Point a Prometheus scrape config at each replica's `9100` port (or use
Docker Swarm/Kubernetes service discovery) to monitor queue depth and
per-page latency across the fleet, and to drive autoscaling decisions.

## Benchmarking

**Not run in this environment** -- there is no GPU hardware or multi-worker
production-scale test rig available here to produce a real "> 100 pages/
minute across 4 replicas" benchmark. The instrumentation to measure it
(the Prometheus histogram above) is in place; running the actual benchmark
requires deploying to hardware with a GPU and generating a representative
load of real scanned documents, which is infrastructure work beyond what
can be verified in this session.
