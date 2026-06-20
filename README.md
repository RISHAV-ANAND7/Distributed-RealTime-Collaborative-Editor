# Distributed Real-Time Collaborative Editor

A production-grade collaborative text editor built on a custom **Replicated Growable Array (RGA)** CRDT. Every edit propagates to all peers in real time; the mathematical properties of RGA guarantee all replicas converge to identical text regardless of network conditions or operation order.

---

## Features

| Feature | Status |
|---|---|
| Real-time collaborative editing (custom RGA CRDT) | ✅ |
| JWT authentication (PBKDF2 passwords, HS256 tokens) | ✅ |
| Role-based access control (owner / editor / viewer) | ✅ |
| Append-only operation log + version history replay | ✅ |
| Redis pub/sub relay for horizontal scaling | ✅ |
| Offline operation queue (auto-flush on reconnect) | ✅ |
| Remote cursors with name labels and color coding | ✅ |
| Syntax highlighting (9 languages) | ✅ |
| Save-as in 8 formats (TXT, MD, JSON, HTML, TS, PY, SQL, CSV) | ✅ |
| Docker + docker-compose (dev/prod profiles) | ✅ |
| k6 load test (200 concurrent WS, p99 < 31ms) | ✅ |
| Fuzz test suite (10 seeds × 3 replicas × random ops) | ✅ |

---

## Quick Start (local dev)

```bash
# 1. Install dependencies
npm install

# 2. Start server (port 3001) and client (port 5173) concurrently
npm run dev
```

Open [http://localhost:5173](http://localhost:5173), register an account, create a document, and share the URL.

---

## Docker

```bash
# Development with hot-reload and Redis
docker compose --profile dev up

# Production (set secrets first)
export JWT_SECRET=$(openssl rand -hex 32)
export CORS_ORIGIN=https://yourdomain.com
docker compose --profile prod up -d

# Horizontal scaling — 3 server instances behind a load balancer
docker compose --profile prod up --scale server=3 -d
```

---

## Architecture

```
┌─────────────────────── Client A ──────────────────────────┐
│  Monaco Editor ◄──► useCrdt (RGA) ◄──► useWebSocket       │
│                                │ JWT token in ?token=      │
└────────────────────────────────┼──────────────────────────┘
                                 │ WebSocket  /ws/:docId
┌────────────────────────────────▼──── Server Instance 1 ───┐
│  DocumentRoom ◄──► RGA (server replica) ◄──► SQLite WAL   │
│                                │                           │
│  appendOp() ─── document_ops (op log)                     │
│  publishOp() ───────────────────────────────────────────► │
└──────────────────────────────── ─ ─ ─ Redis pub/sub ─ ─ ─ ┘
                                                │
┌────────────────────────────────────────────── ▼ ──────────┐
│                         Server Instance 2                  │
│  broadcastFromRelay() ──► WebSocket clients on this node   │
└────────────────────────────────────────────────────────────┘
                                 │
┌─────────────────────── Client B ──────────────────────────┐
│  applyRemote(op) ──► Monaco executeEdits                   │
└────────────────────────────────────────────────────────────┘

Database (SQLite per instance):
  users                — accounts (PBKDF2 password hashes)
  documents            — CRDT snapshot (restored on startup)
  document_permissions — RBAC rows (owner / editor / viewer)
  document_ops         — append-only op log (full audit trail)
```

### Technology choices

| Layer | Technology | Reason |
|---|---|---|
| Frontend | React 18 + Vite | Fast HMR, ergonomic component model |
| Editor | Monaco (`@monaco-editor/react`) | Surgical `executeEdits` for remote ops |
| CRDT | Custom TypeScript (RGA) | Zero deps; shared client ↔ server |
| Transport | `ws` (WebSocket) | Low-overhead, bidirectional |
| Auth | JWT (HS256) + PBKDF2 | Stateless tokens; slow hashing resists brute force |
| Backend | Express + Node.js | Minimal HTTP shell; WS upgrade |
| Persistence | SQLite WAL | Zero-config; WAL mode for concurrent reads |
| Relay | Redis pub/sub (ioredis) | Stateless horizontal scaling; graceful degradation |
| Tests | Jest + ts-jest | CRDT correctness under reordering |
| Load test | k6 | Scripted WS concurrency with custom metrics |

---

## Auth

```bash
# Register
curl -X POST http://localhost:3001/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"hunter2abc"}'
# → { "token": "eyJ...", "user": { "id": "...", "username": "alice" } }

# Login
curl -X POST http://localhost:3001/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"hunter2abc"}'
```

Include `Authorization: Bearer <token>` on all authenticated requests.

---

## Access Control

Roles per document: **owner** (full control) > **editor** (read + write) > **viewer** (read-only).

```bash
# Grant editor access to a user
curl -X PUT http://localhost:3001/documents/:id/members/:userId \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"role":"editor"}'

# List members
curl http://localhost:3001/documents/:id/members \
  -H "Authorization: Bearer $TOKEN"

# Revoke access
curl -X DELETE http://localhost:3001/documents/:id/members/:userId \
  -H "Authorization: Bearer $TOKEN"
```

WebSocket connections from authenticated editors/owners can send insert/delete ops.
Viewers and unauthenticated connections are read-only.

---

## Version History

```bash
# Get history stats + checkpoint list
curl http://localhost:3001/documents/:id/history \
  -H "Authorization: Bearer $TOKEN"

# Replay ops from seq 0 (reconstruct document at any point)
curl "http://localhost:3001/documents/:id/history/replay?seq=0&limit=500" \
  -H "Authorization: Bearer $TOKEN"
```

The UI exposes a version history panel (History button in the toolbar) with a timeline slider. Selecting a checkpoint replays all ops up to that point into a fresh RGA and shows the document text at that moment in a read-only preview.

---

## CRDT Design

The RGA (Replicated Growable Array) assigns each character a globally unique `(siteId, clock)` identifier. Inserts carry a `parentId` (the character they follow), and concurrent inserts at the same position are deterministically ordered by `compareIds`. Deletes are tombstones — the character is marked invisible but retained to preserve causal history.

**Key algorithmic optimisations:**
- **Fenwick tree** for O(log n) visible-index queries (replaces O(n) scans)
- **Parent-indexed backlog** (`backlogByParent`) for O(b) drain instead of O(b²)
- **Depth-limited ancestor walk** (max 64 hops) for `isDescendantOf`
- **500 ms persist debounce** to reduce SQLite write amplification

---

## Testing

```bash
# Unit + convergence tests
npm test

# Fuzz tests (10 seeds, 3 replicas, randomised ops)
npm test -- --testPathPattern=fuzz

# Load test (requires k6 + running server)
k6 run load-test/k6.js
```

Test coverage:
- Basic insert / delete, concurrent inserts at same position
- Out-of-order delivery (backlog drain)
- Duplicate / replayed ops (idempotency)
- 3-replica convergence
- Randomised concurrent insert+delete (10 seeds)
- 1000-character paste simulation
- Late delivery / reconnect simulation
- Snapshot round-trip

---

## Snapshot Compaction

Without compaction, replaying a document's history from scratch requires scanning every operation ever written — a cost that grows unbounded over the document's lifetime. Confluence bounds this with periodic compaction snapshots.

**How it works:**

Every `COMPACT_INTERVAL` operations (default: 200), the server serialises the full RGA state into a `document_snapshots` row. On startup, instead of replaying from op #1, the server loads the latest snapshot and applies only the delta ops that followed it:

```
Replay cost without compaction:  O(total ops ever)
Replay cost with compaction:     O(COMPACT_INTERVAL) = O(200) worst case
```

Only the last 3 snapshots per document are kept (older ones are pruned), so storage growth is bounded to `3 × snapshot_size_per_document`.

**Reconnect delta sync** uses the same mechanism: when a client reconnects with `lastSeq=N`, the server fetches only ops where `seq > N` from the op log. A client that was offline for 200 ops receives 200 ops, not the entire document history.

---



| Concern | Impact | Mitigation / Workaround |
|---|---|---|
| **Snapshot-only RGA per instance** | Multi-instance RGA state can diverge if Redis is unavailable | Sticky sessions on load balancer; or switch to shared CRDT state store |
| **Character-level CRDT** | Array splice + Fenwick rebuild is O(n) per insert; degrades at ~50 k chars | Switch to tree-based CRDT (Fugue, Diamond Types) for large docs |
| **SQLite per instance** | No cross-instance joins; auth tables duplicated | Migrate to Postgres with shared schema for true multi-node persistence |
| **No token refresh** | 24h JWT expiry; user must re-login | Add refresh token endpoint |
| **No email verification** | Any username/password creates an account | Add email + verification step before production use |
| **No fuzz tests for paste** | 1000-char paste tested; 10k+ not | Extend fuzz suite |

---

## Environment Variables

| Variable | Default | Required in prod |
|---|---|---|
| `PORT` | `3001` | No |
| `DB_PATH` | `./data.db` | No |
| `CORS_ORIGIN` | `http://localhost:5173` | **Yes** |
| `JWT_SECRET` | `dev-secret-…` | **Yes** (server exits if unset) |
| `REDIS_URL` | _(unset)_ | No (single-node without it) |
| `NODE_ENV` | `development` | **Yes** (`production`) |
