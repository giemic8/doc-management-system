import axios from 'axios';

const API_BASE = '/api';

export const api = axios.create({
  baseURL: API_BASE,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('dms_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export async function login(email: string, password: string) {
  const res = await api.post('/auth/login', { email, password });
  if (res.data.token) {
    localStorage.setItem('dms_token', res.data.token);
  }
  return res.data;
}

export async function fetchDocuments(params?: { search?: string; doc_type?: string; status?: string }) {
  const res = await api.get('/documents', { params });
  return res.data.documents;
}

export async function fetchDocumentDetail(id: string) {
  const res = await api.get(`/documents/${id}`);
  return res.data;
}

export async function uploadDocument(file: File) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await api.post('/documents/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data.document;
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
