# PostgreSQL coordinates document ingestion

PostgreSQL is authoritative queue and lifecycle store for document ingestion. Backend adapters create canonical records and Python workers claim `processing` rows with row locks; BullMQ signaling was removed because no worker consumed it, and keeping two coordination models made delivery guarantees ambiguous.
