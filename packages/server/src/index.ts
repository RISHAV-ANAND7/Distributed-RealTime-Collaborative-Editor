/**
 * index.ts — HTTP + WebSocket server
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CRDTOperation } from '@crdts/crdt-core';
import { DocumentRoom } from './room.js';
import type { CursorMessage, HeartbeatMessage } from './room.js';
import {
  initStorage,
  getAllDocumentIds,
  getDocumentMeta,
  upsertDocumentMeta,
  updateDocumentTitle,
  deleteDocument as deleteDocFromDB,
  createUser,
  getUserByUsername,
  getUserById,
  getOpsAfter,
  getOpStats,
  getVersionCheckpoints,
} from './storage.js';
import {
  hashPassword,
  verifyPassword,
  signToken,
  requireAuth,
  optionalAuth,
  extractWsToken,
  createWsTicket,
  type AuthRequest,
} from './auth.js';
import {
  grantPermission,
  revokePermission,
  getUserRole,
  getDocumentIdsForUser,
  listMembers,
  requireDocRole,
  type Role,
} from './permissions.js';
import {
  initRelay,
  registerRoom,
  unregisterRoom,
  relayEnabled,
} from './relay.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3001);
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:5173';

if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGIN) {
  console.warn('[server] WARNING: CORS_ORIGIN not set in production — defaulting to localhost');
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '64kb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth requests — please try again later' },
});

// ---------------------------------------------------------------------------
// State — db initialised in bootstrap() before any requests are served
// ---------------------------------------------------------------------------

const rooms = new Map<string, DocumentRoom>();
// Lazy getter: always reads the live db reference after bootstrap().
// This pattern replaces the previous `null as any` anti-pattern.
let _db: Awaited<ReturnType<typeof initStorage>> | null = null;
const getDb = () => {
  if (!_db) throw new Error('Storage not initialised');
  return _db;
};

async function getOrCreateRoom(id: string): Promise<DocumentRoom> {
  let room = rooms.get(id);
  if (room) return room;
  // Minimal fresh room — no snapshot available (new doc created mid-session).
  room = new DocumentRoom(id);
  rooms.set(id, room);
  registerRoom(id, room);
  return room;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  _db = await initStorage();
  await initRelay();

  const ids = await getAllDocumentIds();
  let restored = 0;
  for (const id of ids) {
    const meta = await getDocumentMeta(id);
    if (!meta) continue;
    try {
      const room = await DocumentRoom.restore(id, meta);
      rooms.set(id, room);
      registerRoom(id, room);
      restored++;
    } catch (err) {
      console.error(`[bootstrap] Failed to restore room ${id}:`, err);
    }
  }
  console.log(
    `[server] Restored ${restored} document(s). ` +
    `Redis relay: ${relayEnabled ? 'enabled' : 'disabled (single-node mode)'}`,
  );
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, relay: relayEnabled, ts: Date.now() });
});

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

app.post('/auth/register', authLimiter, async (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || username.length < 3 || username.length > 32) {
    return void res.status(400).json({ error: 'username must be 3–32 characters' });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return void res.status(400).json({ error: 'username may only contain letters, numbers, _ and -' });
  }
  // Enforce max length to prevent PBKDF2 CPU-exhaustion via huge inputs.
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) {
    return void res.status(400).json({ error: 'password must be 8–1024 characters' });
  }
  const existing = await getUserByUsername(username);
  if (existing) return void res.status(409).json({ error: 'Username already taken' });

  const id = randomUUID();
  const hash = await hashPassword(password);
  await createUser(id, username, hash);
  const token = signToken({ sub: id, username });
  res.status(201).json({ token, user: { id, username } });
});

app.post('/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return void res.status(400).json({ error: 'username and password required' });
  }
  const user = await getUserByUsername(username);
  if (!user) return void res.status(401).json({ error: 'Invalid credentials' });

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return void res.status(401).json({ error: 'Invalid credentials' });

  const token = signToken({ sub: user.id, username: user.username });
  res.json({ token, user: { id: user.id, username: user.username } });
});

app.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user!.sub, username: req.user!.username } });
});

/**
 * POST /auth/ws-ticket
 * Authenticated users call this endpoint to get a short-lived (30 s) opaque
 * ticket. The ticket is then passed as ?ticket= in the WebSocket URL instead
 * of the raw JWT — preventing the JWT from appearing in server access logs,
 * browser history, and nginx proxy logs.
 */
app.post('/auth/ws-ticket', requireAuth, (req, res) => {
  const ticket = createWsTicket(req.user!);
  res.json({ ticket, expiresInMs: 30_000 });
});

// ---------------------------------------------------------------------------
// Document routes
// ---------------------------------------------------------------------------

/**
 * Issue 3 FIX: /documents returns ONLY documents the authenticated user can access.
 * Unauthenticated requests receive an empty list (or 401 — choose per product needs;
 * here we return 401 to enforce login before listing).
 */
app.get('/documents', requireAuth, async (req, res) => {
  const docIds = await getDocumentIdsForUser(getDb(), req.user!.sub);
  const list = docIds
    .map((id) => rooms.get(id))
    .filter((r): r is DocumentRoom => r != null)
    .map((r) => r.toSummary())
    .sort((a, b) => b.lastModifiedAt - a.lastModifiedAt);
  res.json(list);
});

app.post('/documents', requireAuth, async (req, res) => {
  const rawTitle = (req.body?.title as string | undefined)?.trim() ?? '';
  const title = rawTitle.slice(0, 120) || 'Untitled document';
  const id = randomUUID().slice(0, 8);
  const now = Date.now();
  const room = new DocumentRoom(id, { title, createdAt: now, lastModifiedAt: now });
  rooms.set(id, room);
  registerRoom(id, room);

  await upsertDocumentMeta(id, title, now);
  await grantPermission(getDb(), id, req.user!.sub, 'owner');

  res.status(201).json(room.toSummary());
});

app.get('/documents/:id', requireAuth, async (req, res) => {
  const role = await getUserRole(getDb(), req.params['id'], req.user!.sub);
  if (!role) return void res.status(403).json({ error: 'Access denied' });
  const room = rooms.get(req.params['id']);
  if (!room) return void res.status(404).json({ error: 'Not found' });
  res.json({ ...room.toSummary(), text: room.rga.getText() });
});

/**
 * Issue 2 FIX: requireDocRole uses a lazy getter (no null as any).
 * Owner-only routes correctly validate the owner role at request time.
 */
app.patch(
  '/documents/:id',
  requireAuth,
  requireDocRole(getDb, 'owner'),
  async (req, res) => {
    const room = rooms.get(req.params['id']);
    if (!room) return void res.status(404).json({ error: 'Not found' });
    const rawTitle = (req.body?.title as string | undefined)?.trim() ?? '';
    if (!rawTitle) return void res.status(400).json({ error: 'title required' });
    room.title = rawTitle.slice(0, 120);
    await updateDocumentTitle(req.params['id'], room.title);
    res.json(room.toSummary());
  },
);

app.delete(
  '/documents/:id',
  requireAuth,
  requireDocRole(getDb, 'owner'),
  async (req, res) => {
    const id = req.params['id'];
    rooms.delete(id);
    unregisterRoom(id);
    await deleteDocFromDB(id);
    res.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// Permission management
// ---------------------------------------------------------------------------

app.get('/documents/:id/members', requireAuth, async (req, res) => {
  const role = await getUserRole(getDb(), req.params['id'], req.user!.sub);
  if (!role) return void res.status(403).json({ error: 'Access denied' });
  const members = await listMembers(getDb(), req.params['id']);
  res.json(members);
});

app.put(
  '/documents/:id/members/:userId',
  requireAuth,
  requireDocRole(getDb, 'owner'),
  async (req, res) => {
    const { role } = req.body ?? {};
    if (!['owner', 'editor', 'viewer'].includes(role)) {
      return void res.status(400).json({ error: 'role must be owner, editor, or viewer' });
    }
    await grantPermission(getDb(), req.params['id'], req.params['userId'], role as Role);
    res.json({ ok: true });
  },
);

app.delete(
  '/documents/:id/members/:userId',
  requireAuth,
  requireDocRole(getDb, 'owner'),
  async (req, res) => {
    if (req.params['userId'] === req.user!.sub) {
      return void res.status(400).json({ error: 'Cannot revoke your own owner access' });
    }
    await revokePermission(getDb(), req.params['id'], req.params['userId']);
    res.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// User lookup (for share / invite by username)
// ---------------------------------------------------------------------------

/**
 * GET /users/lookup?username=xxx
 * Any authenticated user can look up whether a username exists.
 * Returns { id, username } — no sensitive data exposed.
 */
app.get('/users/lookup', requireAuth, async (req, res) => {
  const username = (req.query['username'] as string | undefined)?.trim();
  if (!username || username.length < 1) {
    return void res.status(400).json({ error: 'username query param required' });
  }
  const user = await getUserByUsername(username);
  if (!user) return void res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, username: user.username });
});

/**
 * POST /documents/:id/invite
 * Owner-only shortcut: invite a collaborator by username in one step.
 * Body: { username: string, role: 'editor' | 'viewer' }
 * Resolves the username to a userId, then grants the permission.
 */
app.post(
  '/documents/:id/invite',
  requireAuth,
  requireDocRole(getDb, 'owner'),
  async (req, res) => {
    const { username, role } = req.body ?? {};
    if (typeof username !== 'string' || !username.trim()) {
      return void res.status(400).json({ error: 'username required' });
    }
    if (!['editor', 'viewer'].includes(role)) {
      return void res.status(400).json({ error: 'role must be editor or viewer' });
    }
    const targetUser = await getUserByUsername(username.trim());
    if (!targetUser) {
      return void res.status(404).json({ error: `User "${username}" not found` });
    }
    if (targetUser.id === req.user!.sub) {
      return void res.status(400).json({ error: 'You already have access as owner' });
    }
    await grantPermission(getDb(), req.params['id'], targetUser.id, role as Role);
    res.status(201).json({ ok: true, userId: targetUser.id, username: targetUser.username, role });
  },
);

// ---------------------------------------------------------------------------
// Waiting room: approve / reject / list pending
// ---------------------------------------------------------------------------

/** GET /documents/:id/pending — list users waiting in the waiting room */
app.get(
  '/documents/:id/pending',
  requireAuth,
  requireDocRole(getDb, 'owner'),
  async (req, res) => {
    const room = rooms.get(req.params['id']);
    if (!room) return void res.json([]);
    res.json(room.getPendingUsers());
  },
);

/** POST /documents/:id/approve — owner approves a waiting user */
app.post(
  '/documents/:id/approve',
  requireAuth,
  requireDocRole(getDb, 'owner'),
  async (req, res) => {
    const { userId, role } = req.body ?? {};
    if (!userId || typeof userId !== 'string') {
      return void res.status(400).json({ error: 'userId required' });
    }
    if (!['editor', 'viewer'].includes(role)) {
      return void res.status(400).json({ error: 'role must be editor or viewer' });
    }
    // Persist the permission in the database first.
    // If the user has already disconnected the in-memory wakeup is a no-op,
    // but they will reconnect with the correct role from the DB.
    await grantPermission(getDb(), req.params['id'], userId, role as Role);
    // Wake up the pending WebSocket client (if still connected).
    const room = rooms.get(req.params['id']);
    if (room) {
      await room.approvePending(userId, role as 'editor' | 'viewer');
    }
    res.json({ ok: true });
  },
);

/** POST /documents/:id/reject — owner rejects a waiting user */
app.post(
  '/documents/:id/reject',
  requireAuth,
  requireDocRole(getDb, 'owner'),
  async (req, res) => {
    const { userId } = req.body ?? {};
    if (!userId || typeof userId !== 'string') {
      return void res.status(400).json({ error: 'userId required' });
    }
    const room = rooms.get(req.params['id']);
    if (room) {
      room.rejectPending(userId);
    }
    res.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

app.get('/documents/:id/history', requireAuth, async (req, res) => {
  const role = await getUserRole(getDb(), req.params['id'], req.user!.sub);
  if (!role) return void res.status(403).json({ error: 'Access denied' });
  const [stats, checkpoints] = await Promise.all([
    getOpStats(req.params['id']),
    getVersionCheckpoints(req.params['id'], 50),
  ]);
  res.json({ stats, checkpoints });
});

app.get('/documents/:id/history/replay', requireAuth, async (req, res) => {
  const role = await getUserRole(getDb(), req.params['id'], req.user!.sub);
  if (!role) return void res.status(403).json({ error: 'Access denied' });
  const afterSeq = Math.max(0, Number(req.query['seq'] ?? 0));
  const limit = Math.min(2000, Math.max(1, Number(req.query['limit'] ?? 500)));
  const ops = await getOpsAfter(req.params['id'], afterSeq, limit);
  res.json({ ops, count: ops.length });
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.replace(/^\//, '').split('/');
  const docId = parts[0] === 'ws' ? parts[1] : parts[0];
  if (!docId) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, docId);
  });
});

wss.on('connection', async (socket: WebSocket, req: http.IncomingMessage, docId: string) => {
  const url = req.url ?? '/';
  const jwtPayload = extractWsToken(url);
  const userId = jwtPayload?.sub ?? null;

  let role: Role | null = null;
  if (userId) {
    role = await getUserRole(getDb(), docId, userId);
    if (!role) {
      // No permission → waiting room instead of rejection
      role = 'pending' as Role;
    }
  } else {
    // Not authenticated at all → close
    socket.send(JSON.stringify({ type: 'error', message: 'Please login first' }));
    socket.close(1008, 'Not authenticated');
    return;
  }

  // Reconnect reconciliation: client sends lastSeq query param.
  const params = new URL(url, 'http://localhost').searchParams;
  const lastSeq = Math.max(0, Number(params.get('lastSeq') ?? 0));

  const room = await getOrCreateRoom(docId);
  const authUsername = jwtPayload?.username ?? null;
  // Sanitize displayName: cap length and strip control characters.
  const rawDisplayName = params.get('name') ?? null;
  const displayName = rawDisplayName
    ? rawDisplayName.replace(/[\x00-\x1f]/g, '').slice(0, 64)
    : null;
  const attached = await room.addClient(socket, userId, role, lastSeq, authUsername, displayName);

  const MAX_MSG_BYTES = 4096;

  socket.on('message', (raw) => {
    const str = raw.toString();
    if (str.length > MAX_MSG_BYTES) return;
    let msg: any;
    try { msg = JSON.parse(str); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'insert' || msg.type === 'delete') {
      room.handleOperation(msg as CRDTOperation, attached);
    } else if (msg.type === 'cursor') {
      room.handleCursor(msg as CursorMessage, attached);
    } else if (msg.type === 'heartbeat') {
      room.handleHeartbeat(msg as HeartbeatMessage, attached);
    }
  });

  socket.on('close', () => room.removeClient(attached));
  socket.on('error', (err) => {
    console.error(`[ws:${docId}]`, err.message);
    room.removeClient(attached);
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

bootstrap().then(() => {
  server.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('[server] Bootstrap failed:', err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  console.log(`[server] Received ${signal} — shutting down gracefully…`);
  server.close(async () => {
    // Allow the debounced queuePersist callbacks (500 ms) to fire.
    await new Promise<void>((r) => setTimeout(r, 600));
    await import('./relay.js').then((m) => m.closeRelay()).catch(() => {});
    console.log('[server] Shutdown complete.');
    process.exit(0);
  });
  // Force-exit after 10 s if something hangs.
  setTimeout(() => { console.error('[server] Forced exit after timeout.'); process.exit(1); }, 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));
