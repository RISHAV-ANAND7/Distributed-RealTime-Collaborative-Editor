

import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open, type Database } from 'sqlite';

let db: Database | null = null;

/** Write a compaction snapshot every N ops per document. */
export const COMPACT_INTERVAL = 200;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export async function initStorage(): Promise<Database> {
  if (db) return db;
  const dbPath = process.env.DB_PATH ?? path.resolve(process.cwd(), 'data.db');
  db = await open({ filename: dbPath, driver: sqlite3.Database });

 
  await db.exec('PRAGMA journal_mode=WAL');
  await db.exec('PRAGMA synchronous=NORMAL');
  await db.exec('PRAGMA foreign_keys=ON');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL DEFAULT 'Untitled document',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC);

    CREATE TABLE IF NOT EXISTS users (
      id              TEXT PRIMARY KEY,
      username        TEXT UNIQUE NOT NULL,
      password_hash   TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

    CREATE TABLE IF NOT EXISTS document_permissions (
      doc_id          TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      role            TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
      granted_at      INTEGER NOT NULL,
      PRIMARY KEY (doc_id, user_id),
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_perms_doc  ON document_permissions(doc_id);
    CREATE INDEX IF NOT EXISTS idx_perms_user ON document_permissions(user_id);

    -- Compaction snapshots: full RGA state at a given seq.
    -- Replay = load latest snapshot + ops WHERE seq > snapshot.seq
    CREATE TABLE IF NOT EXISTS document_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id          TEXT NOT NULL,
      seq             INTEGER NOT NULL,
      snapshot_json   TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_doc_seq ON document_snapshots(doc_id, seq DESC);

    -- Append-only op log with operationId for idempotency.
    CREATE TABLE IF NOT EXISTS document_ops (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id          TEXT NOT NULL,
      operation_id    TEXT UNIQUE NOT NULL,
      op_type         TEXT NOT NULL CHECK(op_type IN ('insert','delete')),
      op_json         TEXT NOT NULL,
      user_id         TEXT,
      site_id         TEXT NOT NULL,
      seq             INTEGER NOT NULL,
      applied_at      INTEGER NOT NULL,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ops_doc_seq    ON document_ops(doc_id, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_opid ON document_ops(operation_id);
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Documents (metadata only — state lives in snapshots)
// ---------------------------------------------------------------------------

export async function upsertDocumentMeta(
  id: string,
  title: string,
  createdAt: number,
): Promise<void> {
  const d = await initStorage();
  await d.run(
    `INSERT INTO documents (id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
    id, title, createdAt, Date.now(),
  );
}

export async function updateDocumentTitle(id: string, title: string): Promise<void> {
  const d = await initStorage();
  await d.run(`UPDATE documents SET title = ?, updated_at = ? WHERE id = ?`, title, Date.now(), id);
}

export async function deleteDocument(id: string): Promise<void> {
  const d = await initStorage();
  await d.run(`DELETE FROM documents WHERE id = ?`, id);
}

export async function getAllDocumentIds(): Promise<string[]> {
  const d = await initStorage();
  const rows = await d.all<{ id: string }[]>(
    `SELECT id FROM documents ORDER BY updated_at DESC`,
  );
  return rows.map((r) => r.id);
}

export async function getDocumentMeta(id: string): Promise<{
  id: string; title: string; createdAt: number; updatedAt: number;
} | null> {
  const d = await initStorage();
  const row = await d.get<{
    id: string; title: string; created_at: number; updated_at: number;
  }>(`SELECT id, title, created_at, updated_at FROM documents WHERE id = ?`, id);
  if (!row) return null;
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}



export interface SnapshotRow {
  id: number;
  docId: string;
  seq: number;
  snapshotJson: string;
  createdAt: number;
}


export async function saveCompactionSnapshot(
  docId: string,
  seq: number,
  rgaState: unknown,
): Promise<void> {
  const d = await initStorage();
  await d.run(
    `INSERT INTO document_snapshots (doc_id, seq, snapshot_json, created_at)
     VALUES (?, ?, ?, ?)`,
    docId, seq, JSON.stringify(rgaState), Date.now(),
  );
  // Keep only the last 3 snapshots per document to bound storage growth.
  await d.run(
    `DELETE FROM document_snapshots
     WHERE doc_id = ? AND id NOT IN (
       SELECT id FROM document_snapshots WHERE doc_id = ? ORDER BY seq DESC LIMIT 3
     )`,
    docId, docId,
  );
}


export async function loadLatestSnapshot(docId: string): Promise<SnapshotRow | null> {
  const d = await initStorage();
  const row = await d.get<{
    id: number; doc_id: string; seq: number; snapshot_json: string; created_at: number;
  }>(
    `SELECT id, doc_id, seq, snapshot_json, created_at
     FROM document_snapshots WHERE doc_id = ? ORDER BY seq DESC LIMIT 1`,
    docId,
  );
  if (!row) return null;
  return {
    id: row.id,
    docId: row.doc_id,
    seq: row.seq,
    snapshotJson: row.snapshot_json,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Operation log
// ---------------------------------------------------------------------------

export interface OpLogEntry {
  id: number;
  docId: string;
  operationId: string;
  opType: 'insert' | 'delete';
  opJson: string;
  userId: string | null;
  siteId: string;
  seq: number;
  appliedAt: number;
}


export async function appendOp(
  docId: string,
  operationId: string,
  op: { type: 'insert' | 'delete'; [k: string]: unknown },
  siteId: string,
  seq: number,
  userId?: string,
): Promise<boolean> {
  const d = await initStorage();
  try {
    await d.run(
      `INSERT INTO document_ops
         (doc_id, operation_id, op_type, op_json, user_id, site_id, seq, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      docId, operationId, op.type, JSON.stringify(op),
      userId ?? null, siteId, seq, Date.now(),
    );
    return true;
  } catch (err: any) {
    // UNIQUE constraint on operation_id — duplicate, skip silently.
    if (err?.code === 'SQLITE_CONSTRAINT') return false;
    throw err;
  }
}


export async function opExists(operationId: string): Promise<boolean> {
  const d = await initStorage();
  const row = await d.get<{ id: number }>(
    `SELECT id FROM document_ops WHERE operation_id = ? LIMIT 1`,
    operationId,
  );
  return row != null;
}

export async function getOpsAfter(
  docId: string,
  afterSeq = 0,
  limit = 2000,
): Promise<OpLogEntry[]> {
  const d = await initStorage();
  const rows = await d.all<Array<{
    id: number; doc_id: string; operation_id: string; op_type: string; op_json: string;
    user_id: string | null; site_id: string; seq: number; applied_at: number;
  }>>(
    `SELECT id, doc_id, operation_id, op_type, op_json, user_id, site_id, seq, applied_at
     FROM document_ops
     WHERE doc_id = ? AND seq > ?
     ORDER BY seq ASC LIMIT ?`,
    docId, afterSeq, limit,
  );
  return rows.map((r) => ({
    id: r.id,
    docId: r.doc_id,
    operationId: r.operation_id,
    opType: r.op_type as 'insert' | 'delete',
    opJson: r.op_json,
    userId: r.user_id,
    siteId: r.site_id,
    seq: r.seq,
    appliedAt: r.applied_at,
  }));
}

export async function getOpStats(docId: string): Promise<{
  totalOps: number;
  firstOpAt: number | null;
  lastOpAt: number | null;
  contributors: Array<{ userId: string; username: string; opCount: number }>;
}> {
  const d = await initStorage();
  const stats = await d.get<{
    total: number; first_at: number | null; last_at: number | null;
  }>(
    `SELECT COUNT(*) AS total, MIN(applied_at) AS first_at, MAX(applied_at) AS last_at
     FROM document_ops WHERE doc_id = ?`,
    docId,
  );
  const contribs = await d.all<Array<{ user_id: string; username: string; cnt: number }>>(
    `SELECT p.user_id, u.username, COUNT(*) AS cnt
     FROM document_ops p
     JOIN users u ON u.id = p.user_id
     WHERE p.doc_id = ? AND p.user_id IS NOT NULL
     GROUP BY p.user_id ORDER BY cnt DESC`,
    docId,
  );
  return {
    totalOps: stats?.total ?? 0,
    firstOpAt: stats?.first_at ?? null,
    lastOpAt: stats?.last_at ?? null,
    contributors: contribs.map((c) => ({
      userId: c.user_id, username: c.username, opCount: c.cnt,
    })),
  };
}


export async function getVersionCheckpoints(docId: string, limit = 50): Promise<OpLogEntry[]> {
  const d = await initStorage();
  const rows = await d.all<Array<{
    id: number; doc_id: string; operation_id: string; op_type: string; op_json: string;
    user_id: string | null; site_id: string; seq: number; applied_at: number;
  }>>(
    `WITH numbered AS (
       SELECT id, doc_id, operation_id, op_type, op_json, user_id, site_id, seq, applied_at,
              ROW_NUMBER() OVER (ORDER BY seq ASC) AS rn,
              COUNT(*) OVER ()                     AS total
       FROM document_ops
       WHERE doc_id = ?
     )
     SELECT id, doc_id, operation_id, op_type, op_json, user_id, site_id, seq, applied_at
     FROM numbered
     WHERE total <= ? OR (rn - 1) % MAX(1, (total / ?)) = 0
     ORDER BY seq ASC
     LIMIT ?`,
    docId, limit, limit, limit,
  );
  return rows.map((r) => ({
    id: r.id,
    docId: r.doc_id,
    operationId: r.operation_id,
    opType: r.op_type as 'insert' | 'delete',
    opJson: r.op_json,
    userId: r.user_id,
    siteId: r.site_id,
    seq: r.seq,
    appliedAt: r.applied_at,
  }));
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: number;
}

export async function createUser(
  id: string,
  username: string,
  passwordHash: string,
): Promise<void> {
  const d = await initStorage();
  await d.run(
    `INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)`,
    id, username, passwordHash, Date.now(),
  );
}

export async function getUserByUsername(username: string): Promise<UserRow | null> {
  const d = await initStorage();
  const row = await d.get<{
    id: string; username: string; password_hash: string; created_at: number;
  }>(`SELECT id, username, password_hash, created_at FROM users WHERE username = ?`, username);
  if (!row) return null;
  return { id: row.id, username: row.username, passwordHash: row.password_hash, createdAt: row.created_at };
}

export async function getUserById(id: string): Promise<UserRow | null> {
  const d = await initStorage();
  const row = await d.get<{
    id: string; username: string; password_hash: string; created_at: number;
  }>(`SELECT id, username, password_hash, created_at FROM users WHERE id = ?`, id);
  if (!row) return null;
  return { id: row.id, username: row.username, passwordHash: row.password_hash, createdAt: row.created_at };
}
