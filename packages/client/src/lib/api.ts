import { API_URL } from './config';

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

export function getStoredToken(): string | null {
  try { return localStorage.getItem('crdt.auth.token'); } catch { return null; }
}

function authHeaders(): Record<string, string> {
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ---------------------------------------------------------------------------
// Document API
// ---------------------------------------------------------------------------

export interface DocumentSummary {
  id: string;
  title: string;
  clients: number;
  length: number;
  createdAt: number;
  lastModifiedAt: number;
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  const res = await fetch(`${API_URL}/documents`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function createDocument(title?: string): Promise<DocumentSummary> {
  const res = await fetch(`${API_URL}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function renameDocument(id: string, title: string): Promise<DocumentSummary> {
  const res = await fetch(`${API_URL}/documents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function deleteDocument(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/documents/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ---------------------------------------------------------------------------
// Members API
// ---------------------------------------------------------------------------

export interface Member {
  userId: string;
  username: string;
  role: 'owner' | 'editor' | 'viewer';
  grantedAt: number;
}

export async function listMembers(docId: string): Promise<Member[]> {
  const res = await fetch(`${API_URL}/documents/${docId}/members`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function grantMember(docId: string, userId: string, role: string): Promise<void> {
  const res = await fetch(`${API_URL}/documents/${docId}/members/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function revokeMember(docId: string, userId: string): Promise<void> {
  const res = await fetch(`${API_URL}/documents/${docId}/members/${userId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ---------------------------------------------------------------------------
// User lookup (for invite-by-username)
// ---------------------------------------------------------------------------

export interface UserLookup {
  id: string;
  username: string;
}

export async function lookupUser(username: string): Promise<UserLookup> {
  const res = await fetch(
    `${API_URL}/users/lookup?username=${encodeURIComponent(username)}`,
    { headers: authHeaders() },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as UserLookup;
}

export async function inviteMember(
  docId: string,
  username: string,
  role: 'editor' | 'viewer',
): Promise<void> {
  const res = await fetch(`${API_URL}/documents/${docId}/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ username, role }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
}

// ---------------------------------------------------------------------------
// Waiting room
// ---------------------------------------------------------------------------

export interface PendingUser {
  userId: string;
  username: string;
  displayName: string;
}

export async function listPendingUsers(docId: string): Promise<PendingUser[]> {
  const res = await fetch(`${API_URL}/documents/${docId}/pending`, {
    headers: authHeaders(),
  });
  if (!res.ok) return [];
  return res.json();
}

export async function approveUser(
  docId: string,
  userId: string,
  role: 'editor' | 'viewer',
): Promise<void> {
  const res = await fetch(`${API_URL}/documents/${docId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ userId, role }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
}

export async function rejectUser(docId: string, userId: string): Promise<void> {
  const res = await fetch(`${API_URL}/documents/${docId}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
}
