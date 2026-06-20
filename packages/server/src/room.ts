/**
 * room.ts — in-memory collaborative document room
 *
 * Fixes applied in this version:
 *
 * 1. TRUE MULTI-NODE CRDT CONSISTENCY
 *    broadcastFromRelay() now applies the op to the local RGA *and* broadcasts
 *    to local clients. Previously it only forwarded the raw payload, so this
 *    instance's RGA diverged from peers — new clients joining would receive a
 *    stale snapshot and miss all relayed ops.
 *
 * 2. IDEMPOTENCY / DUPLICATE-OP HANDLING
 *    Every op carries an `operationId` (set by the originating client or
 *    generated server-side). The op log table has a UNIQUE constraint on it.
 *    appliedOps (in-memory Set) deduplicates ops within a session before
 *    touching the RGA. Duplicate ops are silently dropped.
 *
 * 3. RECONNECT RECONCILIATION (delta sync)
 *    addClient() accepts an optional `lastSeq` from the reconnecting client.
 *    If > 0, instead of a full snapshot we load missing ops from the op log
 *    and send them as individual op messages — bandwidth-efficient resync.
 *
 * 4. SNAPSHOT COMPACTION
 *    Every COMPACT_INTERVAL ops, a compaction snapshot is written. On startup,
 *    only ops *after* the latest snapshot need to be replayed. This bounds
 *    replay cost to O(COMPACT_INTERVAL) regardless of document lifetime.
 *
 * 5. VIEWER ENFORCEMENT
 *    Clients with viewer role cannot send insert/delete ops.
 *
 * 6. OP LOG ATTRIBUTION
 *    Ops relayed from Redis peers are also appended to the local op log
 *    (with the correct siteId) so every instance has a complete audit trail.
 */

import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { RGA, type CRDTOperation, type CRDTChar } from '@crdts/crdt-core';
import {
  upsertDocumentMeta,
  appendOp,
  opExists,
  getOpsAfter,
  saveCompactionSnapshot,
  loadLatestSnapshot,
  COMPACT_INTERVAL,
} from './storage.js';
import { publishOp, subscribeToDoc, unsubscribeFromDoc } from './relay.js';
import type { Role } from './permissions.js';

export interface CursorMessage {
  type: 'cursor';
  siteId: string;
  name?: string;
  color?: string;
  position: number;
  typing?: boolean;
}

export interface HeartbeatMessage {
  type: 'heartbeat';
  siteId: string;
  name?: string;
  color?: string;
}

export interface AttachedSocket {
  socket: WebSocket;
  siteId?: string;
  userId: string | null;
  username: string | null;   // authenticated display name from JWT
  displayName: string | null; // per-session nickname chosen in JoinModal
  role: Role | null;
}

// Wire format: ops may carry an optional client-assigned operationId.
// Using a type intersection so operationId and id are always accessible.
type WireOp = CRDTOperation & {
  operationId?: string;
  id: { siteId: string; clock: number };
};

export class DocumentRoom {
  public readonly id: string;
  public title: string;
  public readonly createdAt: number;
  public lastModifiedAt: number;
  public rga: RGA;

  /**
   * Global monotonic sequence counter for this room.
   * Incremented on every successfully applied op.
   * Clients use this for delta-sync on reconnect.
   */
  public seq: number;

  private clients: Set<AttachedSocket> = new Set();
  private pendingClients: Set<AttachedSocket> = new Set();
  private persistQueued = false;
  private opsSinceCompact = 0;

  /**
   * In-memory idempotency set: operationIds applied this session.
   * Guards against duplicates from client offline queues and Redis re-delivery.
   */
  private appliedOps: Set<string> = new Set();

  constructor(
    id: string,
    opts?: {
      title?: string;
      rga?: RGA;
      createdAt?: number;
      lastModifiedAt?: number;
      seq?: number;
    },
  ) {
    this.id = id;
    this.title = opts?.title ?? 'Untitled document';
    this.createdAt = opts?.createdAt ?? Date.now();
    this.lastModifiedAt = opts?.lastModifiedAt ?? this.createdAt;
    this.rga = opts?.rga ?? new RGA(`server:${id}`);
    this.seq = opts?.seq ?? 0;
  }

  get clientCount(): number { return this.clients.size; }
  get pendingCount(): number { return this.pendingClients.size; }

  // -------------------------------------------------------------------------
  // Client lifecycle
  // -------------------------------------------------------------------------

  /**
   * Add a client. If lastSeq > 0 and we have the delta in the op log,
   * send only the missing ops (reconnect reconciliation) instead of a full
   * snapshot. Falls back to full sync if delta is unavailable.
   */
  async addClient(
    socket: WebSocket,
    userId: string | null,
    role: Role | null,
    lastSeq = 0,
    username: string | null = null,
    displayName: string | null = null,
  ): Promise<AttachedSocket> {
    const attached: AttachedSocket = { socket, userId, username, displayName, role };

    // ── Waiting room: pending users don't get document content ──
    if (role === 'pending') {
      this.pendingClients.add(attached);
      socket.send(JSON.stringify({ type: 'waiting', message: 'Waiting for the document owner to approve your request.' }));
      // Notify all connected owners about this join request
      const notification = JSON.stringify({
        type: 'join_request',
        userId,
        username: username ?? 'Unknown',
        displayName: displayName ?? username ?? 'Unknown',
      });
      for (const c of this.clients) {
        if (c.role === 'owner' && c.socket.readyState === 1 /* WebSocket.OPEN */) {
          c.socket.send(notification);
        }
      }
      return attached;
    }

    this.clients.add(attached);

    // Reconnect delta: send only ops the client missed.
    if (lastSeq > 0 && lastSeq < this.seq) {
      const delta = await getOpsAfter(this.id, lastSeq, 2000);
      if (delta.length > 0) {
        socket.send(JSON.stringify({
          type: 'delta',
          fromSeq: lastSeq,
          toSeq: this.seq,
          ops: delta.map((e) => ({ ...JSON.parse(e.opJson), operationId: e.operationId })),
          role: role ?? 'viewer',
          username: username ?? undefined,
        }));
        await subscribeToDoc(this.id);
        return attached;
      }
    }

    // Full sync (first connect or delta unavailable).
    socket.send(JSON.stringify({
      type: 'sync',
      sequence: this.rga.getSequence(),
      clock: this.rga.clock,
      seq: this.seq,
      title: this.title,
      role: role ?? 'viewer',
      username: username ?? undefined,
    }));

    await subscribeToDoc(this.id);
    return attached;
  }

  removeClient(attached: AttachedSocket): void {
    this.clients.delete(attached);
    this.pendingClients.delete(attached);
    if (attached.siteId) {
      this.broadcast(JSON.stringify({ type: 'leave', siteId: attached.siteId }), null);
    }
    if (this.clients.size === 0 && this.pendingClients.size === 0) {
      unsubscribeFromDoc(this.id);
    }
  }

  // -------------------------------------------------------------------------
  // Waiting room: approve / reject pending users
  // -------------------------------------------------------------------------

  /**
   * Approve a pending user: move them from pendingClients → clients,
   * upgrade their role, and send them the full document sync.
   */
  async approvePending(userId: string, newRole: 'editor' | 'viewer'): Promise<boolean> {
    for (const pending of this.pendingClients) {
      if (pending.userId === userId) {
        this.pendingClients.delete(pending);
        pending.role = newRole;
        this.clients.add(pending);
        // Send the full document sync to the approved user
        pending.socket.send(JSON.stringify({
          type: 'approved',
          role: newRole,
        }));
        pending.socket.send(JSON.stringify({
          type: 'sync',
          sequence: this.rga.getSequence(),
          clock: this.rga.clock,
          seq: this.seq,
          title: this.title,
          role: newRole,
          username: pending.username ?? undefined,
        }));
        return true;
      }
    }
    return false;
  }

  /**
   * Reject a pending user: send them a rejected message and close the socket.
   */
  rejectPending(userId: string): boolean {
    for (const pending of this.pendingClients) {
      if (pending.userId === userId) {
        this.pendingClients.delete(pending);
        pending.socket.send(JSON.stringify({ type: 'rejected', message: 'Your request was denied by the document owner.' }));
        pending.socket.close(1008, 'Request denied');
        return true;
      }
    }
    return false;
  }

  /** Return info about all currently pending users. */
  getPendingUsers(): Array<{ userId: string; username: string; displayName: string }> {
    const result: Array<{ userId: string; username: string; displayName: string }> = [];
    for (const p of this.pendingClients) {
      if (p.userId) {
        result.push({
          userId: p.userId,
          username: p.username ?? 'Unknown',
          displayName: p.displayName ?? p.username ?? 'Unknown',
        });
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Operation handling
  // -------------------------------------------------------------------------

  handleOperation(wireOp: CRDTOperation & { operationId?: string }, from: AttachedSocket): boolean {
    if (from.role === 'viewer' || from.role === 'pending') {
      from.socket.send(JSON.stringify({ type: 'error', message: 'Read-only access' }));
      return false;
    }

    if (!this.isValidOp(wireOp)) return false;

    // Idempotency: assign an operationId if the client didn't send one.
    const operationId = wireOp.operationId ?? randomUUID();

    // In-memory dedup (fast path — avoids DB round-trip for same session).
    if (this.appliedOps.has(operationId)) return false;
    this.appliedOps.add(operationId);

    // Apply to local RGA.
    this.rga.applyRemote(wireOp);
    this.lastModifiedAt = Date.now();
    this.seq++;
    this.opsSinceCompact++;
    this.queuePersist();

    // Broadcast to local clients (with operationId so receivers can dedup too).
    const broadcastOp: WireOp = { ...wireOp, operationId };
    const payload = JSON.stringify(broadcastOp);
    this.broadcast(payload, from);

    // Append to op log (non-blocking; idempotent via UNIQUE constraint).
    const opForLog = wireOp as unknown as { type: 'insert' | 'delete'; [k: string]: unknown };
    appendOp(this.id, operationId, opForLog, from.siteId ?? this.rga.siteId, this.seq, from.userId ?? undefined)
      .catch((err) => console.error(`[room:${this.id}] op log write failed:`, err));

    // Publish to Redis peers.
    publishOp(this.id, JSON.stringify({ op: broadcastOp, seq: this.seq }))
      .catch((err) => console.error(`[room:${this.id}] redis publish failed:`, err));

    // Trigger compaction snapshot if interval reached.
    if (this.opsSinceCompact >= COMPACT_INTERVAL) {
      this.opsSinceCompact = 0;
      this.writeCompactionSnapshot().catch((err) =>
        console.error(`[room:${this.id}] compaction failed:`, err),
      );
    }

    return true;
  }

  handleCursor(msg: CursorMessage, from: AttachedSocket): void {
    if (typeof msg.siteId !== 'string') return;
    if (typeof msg.position !== 'number' || msg.position < 0) return;
    from.siteId = msg.siteId;
    this.broadcast(JSON.stringify(msg), from);
  }

  handleHeartbeat(msg: HeartbeatMessage, from: AttachedSocket): void {
    if (typeof msg.siteId !== 'string') return;
    from.siteId = msg.siteId;
    // Broadcast heartbeat so all peers can refresh lastSeen
    this.broadcast(JSON.stringify(msg), from);
  }

  /**
   * Called by the Redis subscriber when a peer instance publishes an op.
   *
   * Fix for multi-node consistency: we now APPLY the op to the local RGA
   * so this instance's state stays in sync with peers. Previously we only
   * forwarded the raw payload — this caused divergence: if Client-B reconnects
   * to Instance-2, it would get Instance-2's stale RGA snapshot (missing all
   * ops that came via relay from Instance-1).
   */
  applyFromRelay(raw: string): void {
    try {
      const { op, seq: remoteSeq }: { op: WireOp; seq: number } = JSON.parse(raw);
      if (!op || !this.isValidOp(op)) return;

      const operationId = op.operationId ?? randomUUID();

      // Idempotency guard.
      if (this.appliedOps.has(operationId)) return;
      this.appliedOps.add(operationId);

      // Apply to local RGA so this instance's state stays consistent.
      this.rga.applyRemote(op);
      this.lastModifiedAt = Date.now();
      // Advance seq if the relay op is ahead (may arrive slightly out of order).
      if (remoteSeq > this.seq) this.seq = remoteSeq;
      this.opsSinceCompact++;
      this.queuePersist();

      // Append to local op log for audit trail and reconnect delta.
      const opForLog = op as unknown as { type: 'insert' | 'delete'; [k: string]: unknown };
      appendOp(this.id, operationId, opForLog, op.id?.siteId ?? 'relay', this.seq)
        .catch(() => { /* silently ignore duplicates */ });

      // Forward to local WebSocket clients.
      this.broadcast(JSON.stringify(op), null);

      if (this.opsSinceCompact >= COMPACT_INTERVAL) {
        this.opsSinceCompact = 0;
        this.writeCompactionSnapshot().catch(() => {});
      }
    } catch {
      // Malformed relay message — ignore.
    }
  }

  // -------------------------------------------------------------------------
  // Compaction
  // -------------------------------------------------------------------------

  private async writeCompactionSnapshot(): Promise<void> {
    await saveCompactionSnapshot(this.id, this.seq, {
      siteId: this.rga.siteId,
      clock: this.rga.clock,
      sequence: this.rga.getSequence(),
    });
    console.log(`[room:${this.id}] compaction snapshot written at seq=${this.seq}`);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private isValidOp(op: any): op is CRDTOperation {
    if (!op || typeof op !== 'object') return false;
    if (op.type === 'insert') {
      return (
        typeof op.value === 'string' &&
        op.value.length === 1 &&
        op.id &&
        typeof op.id.siteId === 'string' &&
        typeof op.id.clock === 'number' &&
        (op.parentId === null ||
          (typeof op.parentId?.siteId === 'string' && typeof op.parentId?.clock === 'number'))
      );
    }
    if (op.type === 'delete') {
      return op.id && typeof op.id.siteId === 'string' && typeof op.id.clock === 'number';
    }
    return false;
  }

  private broadcast(payload: string, except: AttachedSocket | null): void {
    for (const c of this.clients) {
      if (c === except) continue;
      if (c.socket.readyState === c.socket.OPEN) c.socket.send(payload);
    }
  }

  private queuePersist(): void {
    if (this.persistQueued) return;
    this.persistQueued = true;
    setTimeout(() => {
      this.persistQueued = false;
      upsertDocumentMeta(this.id, this.title, this.createdAt)
        .catch((err) => console.error(`[room:${this.id}] persist meta failed:`, err));
    }, 500);
  }

  toSummary() {
    return {
      id: this.id,
      title: this.title,
      clients: this.clientCount,
      length: this.rga.visibleLength(),
      seq: this.seq,
      createdAt: this.createdAt,
      lastModifiedAt: this.lastModifiedAt,
    };
  }

  /**
   * Reconstruct a room from the latest compaction snapshot + delta ops.
   * This is used at startup to efficiently restore document state without
   * replaying the entire op log from op #1.
   */
  static async restore(id: string, meta: {
    title: string; createdAt: number; updatedAt: number;
  }): Promise<DocumentRoom> {
    // Load latest compaction snapshot.
    const snap = await loadLatestSnapshot(id);

    let rga: RGA;
    let baseSeq = 0;

    if (snap) {
      const state = JSON.parse(snap.snapshotJson);
      rga = new RGA(state.siteId ?? `server:${id}`, state.clock ?? 0);
      if (Array.isArray(state.sequence)) {
        rga.initFromSnapshot({ sequence: state.sequence as CRDTChar[], clock: state.clock ?? 0 });
      }
      baseSeq = snap.seq;
    } else {
      rga = new RGA(`server:${id}`);
    }

    // Apply only delta ops after the snapshot.
    const deltaOps = await getOpsAfter(id, baseSeq, 100_000);
    let maxSeq = baseSeq;
    for (const entry of deltaOps) {
      try {
        const op: CRDTOperation = JSON.parse(entry.opJson);
        rga.applyRemote(op);
        if (entry.seq > maxSeq) maxSeq = entry.seq;
      } catch {
        // Corrupted op — skip.
      }
    }

    return new DocumentRoom(id, {
      title: meta.title,
      rga,
      createdAt: meta.createdAt,
      lastModifiedAt: meta.updatedAt,
      seq: maxSeq,
    });
  }
}
