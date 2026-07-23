"""
Prometheus metrics server for the OCR worker, exposing queue length,
per-page processing latency, and failure rate so multiple worker replicas
can be monitored/autoscaled (Ticket #10).

Runs an HTTP server on METRICS_PORT (default 9100) in a background thread
so it doesn't block the main processing loop.
"""
import os
import threading
from prometheus_client import Counter, Histogram, Gauge, start_http_server

METRICS_PORT = int(os.getenv("METRICS_PORT", "9100"))

documents_processed_total = Counter(
    "dms_worker_documents_processed_total", "Total documents successfully processed"
)
documents_failed_total = Counter(
    "dms_worker_documents_failed_total", "Total documents that failed processing"
)
processing_latency_seconds = Histogram(
    "dms_worker_processing_latency_seconds",
    "Time to process a single document (OCR + AI extraction + embeddings)",
)
pending_queue_length = Gauge(
    "dms_worker_pending_queue_length", "Number of documents currently pending or processing"
)

_server_started = False
_lock = threading.Lock()


def start_metrics_server():
    """Idempotent: safe to call multiple times, starts the HTTP server only once."""
    global _server_started
    with _lock:
        if _server_started:
            return
        start_http_server(METRICS_PORT)
        _server_started = True
        print(f"Prometheus metrics server listening on :{METRICS_PORT}/metrics")
