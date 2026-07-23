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

export async function uploadDocument(file: File, onProgress?: (percent: number) => void) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await api.post('/documents/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
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

export async function bulkDeleteDocuments(documentIds: string[]) {
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
