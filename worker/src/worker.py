import os
import time
import json
import psycopg2
from psycopg2.extras import RealDictCursor
from pgvector.psycopg2 import register_vector
from ocr_engine import OCREngine
from ai_extractor import AIExtractor
from embedding_generator import EmbeddingGenerator, chunk_text
from file_decryption import decrypt_file_to_temp
from metrics import (
    start_metrics_server,
    documents_processed_total,
    documents_failed_total,
    processing_latency_seconds,
    pending_queue_length,
)

DATABASE_URL = os.getenv("DATABASE_URL", "postgres://dms_user:dms_secret_password@localhost:5432/dms_db")

def get_db_connection():
    while True:
        try:
            conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
            register_vector(conn)
            return conn
        except Exception as e:
            print(f"Waiting for Postgres connection... ({e})")
            time.sleep(3)


def process_one_document(conn, doc, ai_extractor, embedding_generator):
    """Processes a single document: OCR -> AI metadata -> embeddings -> DB update.
    Raises on failure; caller is responsible for commit/rollback and metrics."""
    doc_id = doc['id']
    file_path = doc['file_path']

    # If the file is encrypted at rest, decrypt to a temp file for
    # processing; the temp plaintext copy is removed afterwards.
    ocr_source_path = file_path
    decrypted_temp_path = None
    if doc.get('is_encrypted') and doc.get('encryption_iv') and doc.get('encryption_auth_tag'):
        decrypted_temp_path = decrypt_file_to_temp(file_path, doc['encryption_iv'], doc['encryption_auth_tag'])
        ocr_source_path = decrypted_temp_path

    try:
        # 1. OCR Extraction
        ocr_text = OCREngine.extract_text_from_file(ocr_source_path)
        print(f"Extracted {len(ocr_text)} characters of text.")
    finally:
        if decrypted_temp_path and os.path.exists(decrypted_temp_path):
            os.remove(decrypted_temp_path)

    # 2. AI Metadata Extraction
    extraction = ai_extractor.extract_metadata(ocr_text)
    fields = extraction.get('fields', {})
    print(f"AI extracted {len(fields)} scored field(s) via {extraction.get('provider')}")

    with conn.cursor() as cur:
        # 3. OCR text is the machine's own output about the file, not a claim
        # about what the document means, so it is stored directly.
        cur.execute("""
            UPDATE documents
            SET ocr_text = %s,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = %s;
        """, (ocr_text, doc_id))

        # Ticket #35 -- extracted metadata is a proposal with a confidence,
        # never a fact. record_extraction() applies the configured thresholds
        # and apply_document_extractions() writes only what cleared the
        # auto-accept bar, so the worker cannot disagree with the inbox.
        if fields:
            cur.execute(
                "DELETE FROM document_extractions WHERE document_id = %s AND NOT (field = ANY(%s));",
                (doc_id, list(fields.keys()))
            )
        else:
            cur.execute("DELETE FROM document_extractions WHERE document_id = %s;", (doc_id,))

        for field, proposal in fields.items():
            cur.execute(
                "SELECT * FROM record_extraction(%s, %s, %s::jsonb, %s, %s, %s);",
                (
                    doc_id,
                    field,
                    json.dumps(proposal['value']),
                    proposal['confidence'],
                    extraction.get('provider'),
                    extraction.get('model'),
                )
            )

        cur.execute("SELECT apply_document_extractions(%s) AS needs_review;", (doc_id,))
        needs_review = cur.fetchone()['needs_review']

        # 4. Chunk text + generate embeddings for hybrid semantic search (Ticket #4)
        try:
            cur.execute("DELETE FROM document_chunks WHERE document_id = %s;", (doc_id,))
            for idx, chunk in enumerate(chunk_text(ocr_text)):
                embedding = embedding_generator.generate(chunk)
                cur.execute(
                    "INSERT INTO document_chunks (document_id, chunk_index, chunk_text, embedding) VALUES (%s, %s, %s, %s);",
                    (doc_id, idx, chunk, embedding)
                )
        except Exception as embed_err:
            print(f"Embedding generation notice/error for document {doc_id}: {embed_err}")

        # Lifecycle transition stays centralized in PostgreSQL: 'review' while
        # a person still owes an answer -- about a field, or about a duplicate
        # found at ingest -- and 'ready' only when nobody does.
        cur.execute("SELECT settle_document_review(%s) AS status;", (doc_id,))
        settled_status = cur.fetchone()['status']
        print(f"Document {doc_id} settled as '{settled_status}' (needs_review={needs_review})")

    conn.commit()


def process_pending_documents():
    conn = get_db_connection()
    ai_extractor = AIExtractor()
    embedding_generator = EmbeddingGenerator()
    start_metrics_server()

    print("Worker loop running, checking for 'processing' documents...")

    while True:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) AS count FROM documents WHERE status = 'processing';")
                pending_queue_length.set(cur.fetchone()['count'])

                cur.execute("SELECT * FROM documents WHERE status = 'processing' FOR UPDATE SKIP LOCKED LIMIT 1;")
                docs = cur.fetchall()

            if not docs:
                conn.commit()

            for doc in docs:
                doc_id = doc['id']
                print(f"Processing Document ID: {doc_id} ({doc['original_filename']})...")
                start_time = time.time()

                try:
                    process_one_document(conn, doc, ai_extractor, embedding_generator)
                    documents_processed_total.inc()
                    processing_latency_seconds.observe(time.time() - start_time)
                    print(f"Document {doc_id} successfully processed and indexed!")
                except Exception as doc_err:
                    conn.rollback()
                    try:
                        with conn.cursor() as cur:
                            cur.execute(
                                "SELECT * FROM transition_document(%s, 'failed', %s);",
                                (doc_id, str(doc_err))
                            )
                        conn.commit()
                        documents_failed_total.inc()
                        print(f"Document {doc_id} processing FAILED: {doc_err}")
                    except Exception as transition_err:
                        # Ticket #33 -- the document left 'processing' while we
                        # worked on it (a user deleted it into the trash), so
                        # 'failed' is no longer a legal transition. The user's
                        # deletion wins; drop the processing result quietly.
                        conn.rollback()
                        print(
                            f"Document {doc_id} changed state during processing, "
                            f"leaving it as is: {transition_err}"
                        )

        except Exception as err:
            print(f"Worker iteration notice/error: {err}")
            conn.rollback()

        time.sleep(5)


if __name__ == "__main__":
    process_pending_documents()
