import axios from 'axios';
import {
  AnalyticsSummary,
  LoginResult,
  MfaConfirmResult,
  MfaSetupResult,
  MfaStatus,
  SepaQrResult,
  User,
  ShareLinkCreateResult,
  ShareLinkSummary,
  PublicShareInfo,
  BackupStatus,
  Citation,
  AccessGroup,
  AccessGroupMember,
  GroupTagPermission,
  DocumentItem,
  TrashListResult,
  PurgeResult,
  PurgeExpiredResult,
  Space,
  SpaceDetail,
  SpaceKind,
  DirectoryUser,
  EmergencyRequest,
  EmergencyAccessListResult,
} from '../types';

const API_BASE = '/api';
const TOKEN_KEY = 'dms_token';

export const api = axios.create({
  baseURL: API_BASE,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function clearStoredToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const res = await api.post('/auth/login', { email, password });
  if (res.data.token) {
    localStorage.setItem(TOKEN_KEY, res.data.token);
  }
  return res.data;
}

export function logout() {
  clearStoredToken();
}

export async function fetchCurrentUser(): Promise<User> {
  const res = await api.get('/auth/me');
  return res.data.user;
}

export async function verifyMfaLogin(challengeToken: string, code: string): Promise<LoginResult> {
  const res = await api.post('/auth/mfa/verify-login', { challengeToken, code });
  if (res.data.token) {
    localStorage.setItem(TOKEN_KEY, res.data.token);
  }
  return res.data;
}

export async function fetchMfaStatus(): Promise<MfaStatus> {
  const res = await api.get('/auth/mfa/status');
  return res.data;
}

export async function startMfaSetup(): Promise<MfaSetupResult> {
  const res = await api.post('/auth/mfa/setup');
  return res.data;
}

export async function confirmMfaSetup(code: string): Promise<MfaConfirmResult> {
  const res = await api.post('/auth/mfa/confirm', { code });
  return res.data;
}

export async function disableMfa(password: string): Promise<void> {
  await api.post('/auth/mfa/disable', { password });
}

export async function regenerateBackupCodes(password: string): Promise<MfaConfirmResult> {
  const res = await api.post('/auth/mfa/backup-codes/regenerate', { password });
  return res.data;
}

export async function fetchOrgMfaRequirement(): Promise<{ required: boolean }> {
  const res = await api.get('/admin/settings/mfa-required');
  return res.data;
}

export async function setOrgMfaRequirement(required: boolean): Promise<void> {
  await api.put('/admin/settings/mfa-required', { required });
}

export async function fetchDocuments(params?: { search?: string; doc_type?: string; status?: string }) {
  const res = await api.get('/documents', { params });
  return res.data.documents;
}

export async function fetchDocumentDetail(id: string) {
  const res = await api.get(`/documents/${id}`);
  return res.data;
}

export async function uploadDocument(
  file: File,
  onProgress?: (percent: number) => void,
  idempotencyKey: string = crypto.randomUUID()
) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await api.post('/documents/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data', 'Idempotency-Key': idempotencyKey },
    onUploadProgress: (event) => {
      if (onProgress && event.total) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    },
  });
  return res.data.document;
}

export async function bulkAddTag(documentIds: string[], tagId: string) {
  const res = await api.post('/documents/bulk/tag', { documentIds, tagId });
  return res.data;
}

export async function bulkSetDocType(documentIds: string[], docType: string) {
  const res = await api.post('/documents/bulk/doc-type', { documentIds, docType });
  return res.data;
}

/**
 * Ticket #33 — moves the selected documents into the 90-day trash instead of
 * deleting them. Rejects with 423 if any selection is retention-locked.
 */
export async function bulkDeleteDocuments(
  documentIds: string[]
): Promise<{ trashed: number; documentIds: string[] }> {
  const res = await api.post('/documents/bulk/delete', { documentIds });
  return res.data;
}

export async function updateDocumentMetadata(id: string, metadata: any) {
  const res = await api.put(`/documents/${id}`, metadata);
  return res.data.document;
}

export async function fetchTags() {
  const res = await api.get('/tags');
  return res.data.tags;
}

export async function fetchAuditLogs() {
  const res = await api.get('/audit-logs');
  return res.data.audit_logs;
}

export async function fetchWorkflows() {
  const res = await api.get('/workflows');
  return res.data.workflows;
}

export async function hybridSearch(q: string) {
  const res = await api.get('/search', { params: { q } });
  return res.data.results;
}

export async function fetchSepaQr(
  documentId: string,
  params?: { iban?: string; bic?: string; amount?: string | number }
): Promise<SepaQrResult> {
  const res = await api.get(`/documents/${documentId}/sepa-qr`, { params });
  return res.data;
}

export async function fetchAnalyticsSummary(params?: {
  start_date?: string;
  end_date?: string;
  tagId?: string;
  currency?: string;
}): Promise<AnalyticsSummary> {
  const res = await api.get('/analytics/summary', { params });
  return res.data;
}

export async function fetchContracts(params?: { status?: string }) {
  const res = await api.get('/contracts', { params });
  return res.data.contracts;
}

export async function updateContractDetails(
  documentId: string,
  details: {
    customer_number?: string;
    vendor_address?: string;
    notice_period_days?: number;
    contract_end_date?: string;
  }
) {
  const res = await api.put(`/contracts/${documentId}/details`, details);
  return res.data.contract_details;
}

/** Triggers a browser download of the generated cancellation letter PDF. */
export async function downloadCancellationLetter(documentId: string) {
  const token = getStoredToken();
  const res = await fetch(`${API_BASE}/contracts/${documentId}/cancellation-letter`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    throw new Error(`Failed to generate cancellation letter (${res.status})`);
  }
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'kuendigung.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}
export async function createShareLink(
  documentId: string,
  options: { password?: string; expiresInDays?: number; maxDownloads?: number }
): Promise<ShareLinkCreateResult> {
  const res = await api.post(`/documents/${documentId}/share-links`, options);
  return res.data;
}

export async function fetchShareLinks(documentId: string): Promise<ShareLinkSummary[]> {
  const res = await api.get(`/documents/${documentId}/share-links`);
  return res.data.shareLinks;
}

export async function revokeShareLink(documentId: string, linkId: string): Promise<void> {
  await api.delete(`/documents/${documentId}/share-links/${linkId}`);
}

// Public (unauthenticated) guest share routes — deliberately use plain
// fetch rather than the `api` axios instance, since guests have no JWT and
// the `api` instance's interceptor is only relevant for logged-in users.
export async function fetchPublicShareInfo(token: string): Promise<PublicShareInfo> {
  const res = await fetch(`${API_BASE}/share/${token}/info`);
  return res.json();
}

export async function verifyPublicSharePassword(
  token: string,
  password?: string
): Promise<{ valid: boolean; reason?: string }> {
  const res = await fetch(`${API_BASE}/share/${token}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return res.json();
}

export function getPublicShareDownloadUrl(token: string, password?: string): string {
  const params = password ? `?password=${encodeURIComponent(password)}` : '';
  return `${API_BASE}/share/${token}/download${params}`;
}

// Ticket #17 — Offsite Backup & Automated Disaster Recovery admin dashboard.
export async function fetchBackupStatus(): Promise<BackupStatus> {
  const res = await api.get('/backup/status');
  return res.data;
}

// Ticket #18 — Interactive RAG Document Assistant ("Chat with your Archive").
export async function sendChatQuery(
  question: string,
  scope?: { tagId?: string; dateFrom?: string; dateTo?: string }
): Promise<{ answer: string; citations: Citation[] }> {
  const res = await api.post('/chat/query', { question, scope });
  return res.data;
}

// Ticket #19 — Granular Tag & Folder Access Control Lists (ACLs).
export async function fetchAccessGroups(): Promise<AccessGroup[]> {
  const res = await api.get('/access-groups');
  return res.data.groups;
}

export async function createAccessGroup(name: string): Promise<AccessGroup> {
  const res = await api.post('/access-groups', { name });
  return res.data.group;
}

export async function deleteAccessGroup(groupId: string): Promise<void> {
  await api.delete(`/access-groups/${groupId}`);
}

export async function fetchAccessGroupMembers(groupId: string): Promise<AccessGroupMember[]> {
  const res = await api.get(`/access-groups/${groupId}/members`);
  return res.data.members;
}

export async function updateAccessGroupMembers(groupId: string, userIds: string[]): Promise<void> {
  await api.put(`/access-groups/${groupId}/members`, { userIds });
}

export async function fetchAccessGroupTagPermissions(groupId: string): Promise<GroupTagPermission[]> {
  const res = await api.get(`/access-groups/${groupId}/tag-permissions`);
  return res.data.permissions;
}

export async function setAccessGroupTagPermission(
  groupId: string,
  tagId: string,
  permissions: { canRead: boolean; canWrite: boolean; canDelete: boolean }
): Promise<void> {
  await api.put(`/access-groups/${groupId}/tag-permissions/${tagId}`, permissions);
}

export async function removeAccessGroupTagPermission(groupId: string, tagId: string): Promise<void> {
  await api.delete(`/access-groups/${groupId}/tag-permissions/${tagId}`);
}

export async function fetchAllUsers(): Promise<AccessGroupMember[]> {
  const res = await api.get('/admin/users');
  return res.data.users;
}

// Ticket #33 — 90-day trash lifecycle and controlled purge.
export async function fetchTrash(params?: { limit?: number; offset?: number }): Promise<TrashListResult> {
  const res = await api.get('/documents/trash', { params });
  return res.data;
}

export async function trashDocument(documentId: string): Promise<DocumentItem> {
  const res = await api.post(`/documents/${documentId}/trash`);
  return res.data.document;
}

export async function restoreDocument(documentId: string): Promise<DocumentItem> {
  const res = await api.post(`/documents/${documentId}/restore`);
  return res.data.document;
}

/**
 * Admin-only irreversible removal. `confirmation` must equal the document id;
 * the optional flags acknowledge the share-link and backup-policy guards the
 * backend raises as 409 responses.
 */
export async function purgeDocument(
  documentId: string,
  options: { confirmation: string; revokeShareLinks?: boolean; acknowledgeBackupPolicy?: boolean }
): Promise<PurgeResult> {
  const res = await api.post(`/documents/${documentId}/purge`, options);
  return res.data;
}

export async function purgeExpiredDocuments(): Promise<PurgeExpiredResult> {
  const res = await api.post('/documents/trash/purge-expired', { confirmation: 'purge-expired' });
  return res.data;
}

// Ticket #34 — private and shared family spaces.
export async function fetchSpaces(): Promise<Space[]> {
  const res = await api.get('/spaces');
  return res.data.spaces;
}

/** Creating a shared space is admin-only; a private space is open to everyone. */
export async function createSpace(name: string, kind: SpaceKind): Promise<Space> {
  const res = await api.post('/spaces', { name, kind });
  return res.data.space;
}

/**
 * Everyone on the household server, for the member and trusted-contact
 * pickers. Deliberately open to every authenticated role — nominating a
 * trusted contact is the private-space owner's decision, not an admin's.
 */
export async function fetchHouseholdDirectory(): Promise<DirectoryUser[]> {
  const res = await api.get('/spaces/directory');
  return res.data.users;
}

export async function fetchSpaceDetail(spaceId: string): Promise<SpaceDetail> {
  const res = await api.get(`/spaces/${spaceId}`);
  return res.data.space;
}

/** Rejects with 409 `space_not_empty` while the space still holds documents. */
export async function deleteSpace(spaceId: string): Promise<void> {
  await api.delete(`/spaces/${spaceId}`);
}

export async function addSpaceMember(
  spaceId: string,
  userId: string,
  permissions?: { canWrite?: boolean; canDelete?: boolean }
): Promise<void> {
  await api.post(`/spaces/${spaceId}/members`, { userId, ...permissions });
}

export async function removeSpaceMember(spaceId: string, userId: string): Promise<void> {
  await api.delete(`/spaces/${spaceId}/members/${userId}`);
}

/**
 * Nominating a trusted contact grants nothing on its own — it only makes the
 * two-person emergency unlock possible later. Owner-only, private spaces only.
 */
export async function addTrustedContact(spaceId: string, userId: string): Promise<void> {
  await api.post(`/spaces/${spaceId}/trusted-contacts`, { userId });
}

export async function removeTrustedContact(spaceId: string, userId: string): Promise<void> {
  await api.delete(`/spaces/${spaceId}/trusted-contacts/${userId}`);
}

export async function fetchEmergencyRequests(): Promise<EmergencyAccessListResult> {
  const res = await api.get('/emergency-access');
  return res.data;
}

/** `reason` must be at least 10 characters, `hours` between 1 and the server's maxHours. */
export async function requestEmergencyAccess(
  spaceId: string,
  reason: string,
  hours: number
): Promise<EmergencyRequest> {
  const res = await api.post('/emergency-access', { spaceId, reason, hours });
  return res.data.request;
}

/** Approving your own request is refused with 403 `self_approval` — a second person must decide. */
export async function decideEmergencyRequest(
  requestId: string,
  decision: 'approve' | 'deny' | 'revoke'
): Promise<EmergencyRequest> {
  const res = await api.post(`/emergency-access/${requestId}/${decision}`);
  return res.data.request;
}

/** `spaceId: null` moves the document back into the common area. */
export async function moveDocumentToSpace(
  documentId: string,
  spaceId: string | null
): Promise<DocumentItem> {
  const res = await api.put(`/documents/${documentId}/space`, { spaceId });
  return res.data.document;
}
