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
  // Ticket #34 — the family space a document lives in; null/undefined means
  // the common area (everything that existed before spaces).
  space_id?: string | null;
  // Ticket #33 — present once a document sits in the 90-day trash.
  trashed_at?: string;
  purge_after?: string;
  days_remaining?: number;
  purge_eligible?: boolean;
  retention_locked?: boolean;
  active_share_links?: number;
  trashed_by_name?: string | null;
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



// Ticket #33 — 90-day trash lifecycle and controlled purge.
export interface TrashedDocument extends DocumentItem {
  trashed_at: string;
  purge_after: string;
  trashed_by: string | null;
  trashed_by_name: string | null;
  /** Days left in the 90-day window; 0 or negative once the window elapsed. */
  days_remaining: number;
  purge_eligible: boolean;
  retention_locked: boolean;
  active_share_links: number;
  tags: Tag[];
}

export interface TrashListResult {
  documents: TrashedDocument[];
  retentionDays: number;
}

export interface PurgeResult {
  purged: true;
  documentId: string;
  title: string;
  removedFiles: number;
  revokedShareLinks: number;
  versionsRemoved: number;
}

export interface PurgeExpiredResult {
  purged: string[];
  skipped: { documentId: string; reason: string }[];
}

// Ticket #34 — private and shared family spaces.
export type SpaceKind = 'private' | 'shared';

export interface Space {
  id: string;
  name: string;
  kind: SpaceKind;
  owner_id: string;
  owner_name: string | null;
  created_at: string;
  member_count: number;
  document_count: number;
  /**
   * True when the caller may read the documents inside. An admin looking at
   * somebody's private space — or a nominated trusted contact without an
   * approved emergency grant — sees the space but gets `accessible: false`.
   */
  accessible: boolean;
  /** True when the caller is a trusted contact the owner nominated for this space. */
  trusted_contact: boolean;
}

export interface SpaceMember {
  user_id: string;
  name: string | null;
  email: string | null;
  can_write: boolean;
  can_delete: boolean;
}

export interface TrustedContact {
  user_id: string;
  name: string | null;
  email: string | null;
}

export interface SpaceDetail extends Space {
  members: SpaceMember[];
  trusted_contacts: TrustedContact[];
}

/**
 * One account on the household server, as returned by GET /api/spaces/directory.
 * Open to every role: name and address only, no role and no content.
 */
export interface DirectoryUser {
  id: string;
  name: string;
  email: string;
}

export type EmergencyStatus = 'pending' | 'approved' | 'denied' | 'revoked';

export interface EmergencyRequest {
  id: string;
  space_id: string;
  space_name: string;
  space_owner_id: string;
  requested_by: string;
  requested_by_name: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  reason: string;
  requested_hours: number;
  status: EmergencyStatus;
  expires_at: string | null;
  decided_at: string | null;
  last_used_at: string | null;
  use_count: number;
  /** Approved, not revoked and not yet expired — i.e. the grant opens the space right now. */
  active: boolean;
  /** True when the caller may decide this request; never true for their own (two-person rule). */
  can_decide: boolean;
  created_at: string;
}

export interface EmergencyAccessListResult {
  requests: EmergencyRequest[];
  /** Server-side ceiling for the requested duration (hours). */
  maxHours: number;
  defaultHours: number;
}

// ---------------------------------------------------------------------------
// Ticket #37 -- operations dashboard and alerts
// ---------------------------------------------------------------------------

export type OpsComponentName =
  | 'database'
  | 'redis'
  | 'storage'
  | 'backup'
  | 'ingestion'
  | 'worker'
  | 'email_import'
  | 'ai_provider';

export type OpsStatus = 'ok' | 'degraded' | 'failed';
export type OpsSeverity = 'warning' | 'critical';

/**
 * One measured dependency. `metrics` is deliberately loose: each probe
 * reports the numbers that make sense for it (bytes for storage, minutes
 * for the ingestion queue), and by contract none of them ever contains a
 * document title, filename or sender.
 */
export interface OpsComponentHealth {
  component: OpsComponentName;
  status: OpsStatus;
  lastSuccessAt: string | null;
  currentFailure: string | null;
  metrics: Record<string, any>;
  recoveryAction: string;
  lastCheckedAt: string;
}

export interface OpsDelivery {
  id: string;
  channel: string;
  phase: 'alert' | 'recovery';
  status: 'delivered' | 'failed' | 'skipped';
  recipient: string | null;
  error: string | null;
  attemptedAt: string;
}

export interface OpsIncident {
  id: string;
  component: OpsComponentName;
  kind: string;
  severity: OpsSeverity;
  status: 'open' | 'resolved';
  summary: string;
  detail: Record<string, any>;
  /** How often the same problem was observed; deduplication made visible. */
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  recoveryNotifiedAt: string | null;
  deliveries: OpsDelivery[];
}

export interface OpsAlertSettings {
  emailEnabled: boolean;
  recipient: string | null;
  minSeverity: OpsSeverity;
  queueAgeWarnMinutes: number;
  queueAgeFailMinutes: number;
  storageFreeWarnPercent: number;
  storageFreeFailPercent: number;
  backupVerifyMaxAgeHours: number;
  workerStaleMinutes: number;
  emailPollStaleMinutes: number;
  updatedBy: string | null;
  updatedAt: string | null;
  /** Whether the server has an SMTP host at all; false means alerts stay local. */
  smtpConfigured: boolean;
}

export interface OpsDashboardData {
  generatedAt: string;
  overallStatus: OpsStatus;
  components: OpsComponentHealth[];
  incidents: OpsIncident[];
  openIncidents: OpsIncident[];
  settings: OpsAlertSettings;
}

/** Measured filesystem capacity, replacing the app shell's old fixed figure. */
export interface OpsCapacity {
  measuredAt: string | null;
  metrics: Record<string, any>;
}

export interface OpsEvaluationResult {
  opened: number;
  ongoing: number;
  resolved: number;
}

/* ------------------------------------------------------------------ */
/* Review inbox (Ticket #35)                                           */
/* ------------------------------------------------------------------ */

export type ReviewItemKind = 'low_confidence' | 'exact_duplicate' | 'similar_document';
export type ReviewItemStatus = 'open' | 'accepted' | 'corrected' | 'separated' | 'retried' | 'dismissed';
export type ReviewAction = 'accept' | 'correct' | 'retry' | 'separate' | 'dismiss';

/** What the thresholds made of one extracted field. */
export type ReviewDecision = 'auto_accepted' | 'needs_review' | 'discarded';

export interface ReviewProposal {
  field: string;
  proposedValue: any;
  appliedValue: any;
  confidence: number;
  decision: ReviewDecision;
  provider: string | null;
  model: string | null;
  resolvedAt: string | null;
}

/** The other half of a duplicate question; `title` is null when unreadable. */
export interface ReviewCounterpart {
  documentId: string;
  title: string | null;
  redacted: boolean;
  similarity: number | null;
  linkStatus: string | null;
}

export interface ReviewItem {
  id: string;
  documentId: string;
  documentTitle: string;
  documentStatus: string;
  kind: ReviewItemKind;
  status: ReviewItemStatus;
  detail: Record<string, any>;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  counterpart: ReviewCounterpart | null;
  proposals: ReviewProposal[];
}

export interface ReviewSettings {
  autoAcceptConfidence: number;
  reviewConfidence: number;
  duplicateSimilarity: number;
  similarityScanCandidates: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface ReviewResolution {
  item: ReviewItem;
  documentStatus: string;
  appliedFields: string[];
  rejectedFields: string[];
}

export interface SimilarityScanResult {
  scanned: boolean;
  skippedReason?: string;
  candidates: number;
  matches: Array<{ documentId: string; similarity: number }>;
}
