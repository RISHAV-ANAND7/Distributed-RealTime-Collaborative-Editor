/**
 * permissions.ts — per-document role-based access control
 *
 * Roles (ordered by privilege):
 *   owner  — full control: read, write, rename, delete, manage members
 *   editor — read + write
 *   viewer — read-only (cannot send insert/delete ops)
 *
 * Database tables (created in storage.ts):
 *   document_permissions (doc_id, user_id, role, granted_at)
 */

import type { Database } from 'sqlite';
import type { Request, Response, NextFunction } from 'express';

export type Role = 'owner' | 'editor' | 'viewer' | 'pending';

const LEVEL: Record<Role, number> = { owner: 3, editor: 2, viewer: 1, pending: 0 };

export function hasPrivilege(actual: Role, required: Role): boolean {
  return LEVEL[actual] >= LEVEL[required];
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

export async function grantPermission(
  db: Database,
  docId: string,
  userId: string,
  role: Role,
): Promise<void> {
  await db.run(
    `INSERT INTO document_permissions (doc_id, user_id, role, granted_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(doc_id, user_id) DO UPDATE SET role = excluded.role, granted_at = excluded.granted_at`,
    docId, userId, role, Date.now(),
  );
}

export async function revokePermission(
  db: Database,
  docId: string,
  userId: string,
): Promise<void> {
  await db.run(
    `DELETE FROM document_permissions WHERE doc_id = ? AND user_id = ?`,
    docId, userId,
  );
}

export async function getUserRole(
  db: Database,
  docId: string,
  userId: string,
): Promise<Role | null> {
  const row = await db.get<{ role: Role }>(
    `SELECT role FROM document_permissions WHERE doc_id = ? AND user_id = ?`,
    docId, userId,
  );
  return row?.role ?? null;
}

export async function getDocumentIdsForUser(
  db: Database,
  userId: string,
): Promise<string[]> {
  const rows = await db.all<{ doc_id: string }[]>(
    `SELECT doc_id FROM document_permissions WHERE user_id = ? ORDER BY granted_at DESC`,
    userId,
  );
  return rows.map((r) => r.doc_id);
}

export async function listMembers(
  db: Database,
  docId: string,
): Promise<Array<{ userId: string; username: string; role: Role; grantedAt: number }>> {
  const rows = await db.all<Array<{
    user_id: string; username: string; role: Role; granted_at: number;
  }>>(
    `SELECT p.user_id, u.username, p.role, p.granted_at
     FROM document_permissions p
     JOIN users u ON u.id = p.user_id
     WHERE p.doc_id = ?
     ORDER BY p.granted_at ASC`,
    docId,
  );
  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    role: r.role,
    grantedAt: r.granted_at,
  }));
}

// ---------------------------------------------------------------------------
// Express middleware factory
//
// requireDocRole(getDb, minRole) — takes a *getter* function instead of a
// direct Database reference. This defers resolution until request time so
// the middleware can be registered at module-load time (when storageDb is
// still null!) and still receive the fully-initialised db at runtime.
// ---------------------------------------------------------------------------

export function requireDocRole(getDb: () => Database, minRole: Role) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const db = getDb();
    const docId = req.params['id'];
    const userId = req.user!.sub;

    const role = await getUserRole(db, docId, userId);
    if (!role) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    if (!hasPrivilege(role, minRole)) {
      res.status(403).json({ error: `Requires ${minRole} role` });
      return;
    }
    (req as Request & { docRole: Role }).docRole = role;
    next();
  };
}
