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
    meta = ai_extractor.extract_metadata(ocr_text)
    print(f"AI Extracted Metadata: {meta}")

    with conn.cursor() as cur:
        # 3. Update DB
        cur.execute("""
            UPDATE documents 
            SET status = 'processed',
                ocr_text = %s,
                doc_type = %s,
                sender = %s,
                recipient = %s,
                document_date = %s,
                due_date = %s,
                amount = %s,
                summary = %s,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = %s;
        """, (
            ocr_text,
            meta.get('doc_type'),
            meta.get('sender'),
            meta.get('recipient'),
            meta.get('document_date'),
            meta.get('due_date'),
            meta.get('amount'),
            meta.get('summary'),
            doc_id
        ))

        # Add extracted tags
        for tag_name in meta.get('tags', []):
            cur.execute("INSERT INTO tags (name) VALUES (%s) ON CONFLICT (name) DO NOTHING;", (tag_name,))
            cur.execute("""
                INSERT INTO document_tags (document_id, tag_id)
                SELECT %s, id FROM tags WHERE name = %s
                ON CONFLICT DO NOTHING;
            """, (doc_id, tag_name))

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

    conn.commit()


def process_pending_documents():
    conn = get_db_connection()
    ai_extractor = AIExtractor()
    embedding_generator = EmbeddingGenerator()
    start_metrics_server()

    print("Worker loop running, checking for 'pending' or 'processing' documents...")

    while True:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) AS count FROM documents WHERE status = 'pending' OR status = 'processing';")
                pending_queue_length.set(cur.fetchone()['count'])

                cur.execute("SELECT * FROM documents WHERE status = 'pending' OR status = 'processing' LIMIT 5;")
                docs = cur.fetchall()

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
                    documents_failed_total.inc()
                    print(f"Document {doc_id} processing FAILED: {doc_err}")

        except Exception as err:
            print(f"Worker iteration notice/error: {err}")
            conn.rollback()

        time.sleep(5)


if __name__ == "__main__":
    process_pending_documents()
