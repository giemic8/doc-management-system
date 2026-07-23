import os
import time
import json
import psycopg2
from psycopg2.extras import RealDictCursor
from ocr_engine import OCREngine
from ai_extractor import AIExtractor

DATABASE_URL = os.getenv("DATABASE_URL", "postgres://dms_user:dms_secret_password@localhost:5432/dms_db")

def get_db_connection():
    while True:
        try:
            conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
            return conn
        except Exception as e:
            print(f"Waiting for Postgres connection... ({e})")
            time.sleep(3)

def process_pending_documents():
    conn = get_db_connection()
    ai_extractor = AIExtractor()
    
    print("Worker loop running, checking for 'pending' or 'processing' documents...")
    
    while True:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM documents WHERE status = 'pending' OR status = 'processing' LIMIT 5;")
                docs = cur.fetchall()
                
                for doc in docs:
                    doc_id = doc['id']
                    file_path = doc['file_path']
                    print(f"Processing Document ID: {doc_id} ({doc['original_filename']})...")
                    
                    # 1. OCR Extraction
                    ocr_text = OCREngine.extract_text_from_file(file_path)
                    print(f"Extracted {len(ocr_text)} characters of text.")
                    
                    # 2. AI Metadata Extraction
                    meta = ai_extractor.extract_metadata(ocr_text)
                    print(f"AI Extracted Metadata: {meta}")
                    
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
                        
                    conn.commit()
                    print(f"Document {doc_id} successfully processed and indexed!")
                    
        except Exception as err:
            print(f"Worker iteration notice/error: {err}")
            conn.rollback()
            
        time.sleep(5)

if __name__ == "__main__":
    process_pending_documents()
