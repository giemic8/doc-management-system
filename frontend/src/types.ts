export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface DocumentItem {
  id: string;
  title: string;
  original_filename: string;
  file_path: string;
  derived_file_path?: string;
  thumbnail_path?: string;
  file_size: number;
  mime_type: string;
  file_hash: string;
  status: 'pending' | 'processing' | 'processed' | 'error';
  doc_type?: string;
  sender?: string;
  recipient?: string;
  document_date?: string;
  due_date?: string;
  amount?: number;
  currency?: string;
  summary?: string;
  ocr_text?: string;
  version: number;
  created_at: string;
  updated_at: string;
  tags?: Tag[];
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'editor' | 'viewer';
}

export interface AuditLog {
  id: string;
  document_id?: string;
  user_name?: string;
  user_email?: string;
  action: string;
  details?: any;
  created_at: string;
}

export interface Workflow {
  id: string;
  name: string;
  trigger_event: string;
  condition_json: any;
  actions_json: any;
  is_active: boolean;
  created_at: string;
}
