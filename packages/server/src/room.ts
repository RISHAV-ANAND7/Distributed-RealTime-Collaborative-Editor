

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
  username: string | null;
  displayName: string | null;
  role: Role | null;
}


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


  public seq: number;

  private clients: Set<AttachedSocket> = new Set();
  private pendingClients: Set<AttachedSocket> = new Set();
  private persistQueued = false;
  private opsSinceCompact = 0;


  private appliedOps: Set<string> = new Set();
  private static readonly MAX_APPLIED_OPS = 10_000;

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


  async addClient(
    socket: WebSocket,
    userId: string | null,
    role: Role | null,
    lastSeq = 0,
    username: string | null = null,
    displayName: string | null = null,
  ): Promise<AttachedSocket> {
    const attached: AttachedSocket = { socket, userId, username, displayName, role };

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
    // Prune oldest entry if cap exceeded (FIFO — Set preserves insertion order).
    if (this.appliedOps.size > DocumentRoom.MAX_APPLIED_OPS) {
      this.appliedOps.delete(this.appliedOps.values().next().value!);
    }

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
    const opForLog = wireOp as unknown as { type: 'insert' | 'delete';[k: string]: unknown };
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

    const safeName = typeof msg.name === 'string'
      ? msg.name.replace(/[\x00-\x1f"\\]/g, '').slice(0, 64)
      : undefined;
    const safeColor = typeof msg.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(msg.color)
      ? msg.color
      : undefined;
    const sanitized: CursorMessage = {
      type: 'cursor',
      siteId: msg.siteId,
      position: msg.position,
      typing: !!msg.typing,
      ...(safeName !== undefined && { name: safeName }),
      ...(safeColor !== undefined && { color: safeColor }),
    };
    this.broadcast(JSON.stringify(sanitized), from);
  }

  handleHeartbeat(msg: HeartbeatMessage, from: AttachedSocket): void {
    if (typeof msg.siteId !== 'string') return;
    from.siteId = msg.siteId;
    // Sanitize name and color for the same CSS-injection reasons as cursor.
    const safeName = typeof msg.name === 'string'
      ? msg.name.replace(/[\x00-\x1f"\\]/g, '').slice(0, 64)
      : undefined;
    const safeColor = typeof msg.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(msg.color)
      ? msg.color
      : undefined;
    const sanitized: HeartbeatMessage = {
      type: 'heartbeat',
      siteId: msg.siteId,
      ...(safeName !== undefined && { name: safeName }),
      ...(safeColor !== undefined && { color: safeColor }),
    };
    // Broadcast heartbeat so all peers can refresh lastSeen
    this.broadcast(JSON.stringify(sanitized), from);
  }


  applyFromRelay(raw: string): void {
    try {
      const { op, seq: remoteSeq }: { op: WireOp; seq: number } = JSON.parse(raw);
      if (!op || !this.isValidOp(op)) return;

      const operationId = op.operationId ?? randomUUID();

      // In-memory dedup (fast path — avoids DB round-trip for same session).
      if (this.appliedOps.has(operationId)) return;
      this.appliedOps.add(operationId);
      if (this.appliedOps.size > DocumentRoom.MAX_APPLIED_OPS) {
        this.appliedOps.delete(this.appliedOps.values().next().value!);
      }

      // Apply to local RGA so this instance's state stays consistent.
      this.rga.applyRemote(op);
      this.lastModifiedAt = Date.now();
      // Advance seq if the relay op is ahead (may arrive slightly out of order).
      if (remoteSeq > this.seq) this.seq = remoteSeq;
      this.opsSinceCompact++;
      this.queuePersist();

      // Append to local op log for audit trail and reconnect delta.
      const opForLog = op as unknown as { type: 'insert' | 'delete';[k: string]: unknown };
      appendOp(this.id, operationId, opForLog, op.id?.siteId ?? 'relay', this.seq)
        .catch(() => { /* silently ignore duplicates */ });

      // Forward to local WebSocket clients.
      this.broadcast(JSON.stringify(op), null);

      if (this.opsSinceCompact >= COMPACT_INTERVAL) {
        this.opsSinceCompact = 0;
        this.writeCompactionSnapshot().catch(() => { });
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
