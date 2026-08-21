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
  status: 'received' | 'durable' | 'processing' | 'review' | 'ready' | 'failed' | 'trashed';
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
  document_title?: string;
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

export interface LoginResult {
  token?: string;
  user?: User;
  mfaRequired?: boolean;
  mfaSetupRequired?: boolean;
  challengeToken?: string;
}

export interface MfaSetupResult {
  qrCodeDataUrl: string;
  secret: string;
}

export interface MfaConfirmResult {
  backupCodes: string[];
}

export interface MfaStatus {
  mfaEnabled: boolean;
  backupCodesRemaining: number;
}

export interface SepaQrResult {
  qrCodeDataUrl: string;
  payload: string;
}

export interface MonthlyBreakdownEntry {
  month: string;
  total: number;
  count: number;
}

export interface VendorEntry {
  sender: string;
  total: number;
  count: number;
}

export interface RecurringSubscription {
  sender: string;
  cadence: 'monthly' | 'yearly';
  averageAmount: number;
  occurrences: number;
}

export interface AnalyticsSummary {
  monthlyBreakdown: MonthlyBreakdownEntry[];
  topVendors: VendorEntry[];
  recurringSubscriptions: RecurringSubscription[];
}

export interface ShareLinkSummary {
  id: string;
  expires_at: string | null;
  max_downloads: number | null;
  download_count: number;
  created_at: string;
}

export interface ShareLinkCreateResult {
  shareUrl: string;
  token: string;
  expiresAt: string | null;
  maxDownloads: number | null;
}

export interface PublicShareInfo {
  documentTitle?: string;
  requiresPassword?: boolean;
  valid: boolean;
  reason?: 'expired' | 'revoked' | 'limit_exceeded' | 'locked';
}

export interface BackupStatus {
  timestamp: string | null;
  dbBackupSizeBytes: number;
  storageBackupSizeBytes: number;
  success: boolean;
  error?: string;
  storageUsageBytes: number;
}

// Ticket #18 — Interactive RAG Document Assistant ("Chat with your Archive").
export interface Citation {
  marker: string; // e.g. "[1]"
  documentId: string;
  chunkIndex: number;
  snippet: string;
  documentTitle: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
}

// Ticket #19 — Granular Tag & Folder Access Control Lists (ACLs).
export interface AccessGroup {
  id: string;
  name: string;
  created_at: string;
  member_count: number;
  granted_tag_count: number;
}

export interface AccessGroupMember {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface GroupTagPermission {
  tag_id: string;
  tag_name: string;
  tag_color: string;
  can_read: boolean;
  can_write: boolean;
  can_delete: boolean;
}


