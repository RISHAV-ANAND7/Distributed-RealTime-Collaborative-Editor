import {
  charIdEquals,
  charIdKey,
  compareIds,
  type CharId,
  type CRDTChar,
} from './char.js';
import type {
  CRDTOperation,
  DeleteOp,
  InsertOp,
  RemoteOperationEvent,
} from './operation.js';

export class RGA {
  public readonly siteId: string;
  public clock: number;

  private sequence: CRDTChar[] = [];
  private indexById: Map<string, number> = new Map();

  private insertBacklog: InsertOp[] = [];
  private backlogByParent: Map<string, InsertOp[]> = new Map();

  private tombstonedIds: Set<string> = new Set();

  private fenwick: number[] = [];

  constructor(siteId: string, clock: number = 0) {
    this.siteId = siteId;
    this.clock = clock;
  }

  // ------------------------------------------------------------------
  // Inspection
  // ------------------------------------------------------------------

  getText(): string {
    let out = '';
    for (const c of this.sequence) if (!c.tombstone) out += c.value;
    return out;
  }

  getSequence(): CRDTChar[] {
    return this.sequence.slice();
  }

  snapshot() {
    return {
      siteId: this.siteId,
      clock: this.clock,
      sequence: this.sequence,
    };
  }

  visibleLength(): number {
    return this.fenwick.length > 0
      ? this.fenwickQuery(this.sequence.length)
      : this._visibleLengthLinear();
  }

  private _visibleLengthLinear(): number {
    let n = 0;
    for (const c of this.sequence) if (!c.tombstone) n++;
    return n;
  }

  // ------------------------------------------------------------------
  // Restoration
  // ------------------------------------------------------------------

  initFromSnapshot(snapshot: { sequence: CRDTChar[]; clock?: number }) {
    this.sequence = snapshot.sequence.map((c) => ({ ...c }));
    this.indexById.clear();
    this.fenwick = new Array(this.sequence.length + 1).fill(0);

    for (let i = 0; i < this.sequence.length; i++) {
      this.indexById.set(charIdKey(this.sequence[i].id), i);
      if (!this.sequence[i].tombstone) this.fenwickUpdate(i, 1);
    }

    let max = snapshot.clock ?? 0;
    for (const c of this.sequence) if (c.id.clock > max) max = c.id.clock;
    this.clock = Math.max(this.clock, max);

    // Clear any stale backlog state on resync.
    this.insertBacklog = [];
    this.backlogByParent.clear();
    this.tombstonedIds.clear();
  }

  // ------------------------------------------------------------------
  // Local mutation
  // ------------------------------------------------------------------

  localInsert(visibleIndex: number, value: string): InsertOp {
    this.clock += 1;
    const id: CharId = { siteId: this.siteId, clock: this.clock };
    const parent = this.charAtVisible(visibleIndex - 1);
    const parentId: CharId | null = parent ? parent.id : null;
    const char: CRDTChar = { id, value, tombstone: false, parentId };
    const insertAt = this.findInsertSlot(parentId, id);
    this.spliceInsert(insertAt, char);
    return { type: 'insert', id, value, parentId };
  }

  localDelete(visibleIndex: number): DeleteOp | null {
    const target = this.charAtVisible(visibleIndex);
    if (!target) return null;
    const rawIdx = this.indexById.get(charIdKey(target.id))!;
    target.tombstone = true;
    this.fenwickUpdate(rawIdx, -1);
    return { type: 'delete', id: target.id };
  }

  // ------------------------------------------------------------------
  // Remote application
  // ------------------------------------------------------------------

  applyRemote(op: CRDTOperation): RemoteOperationEvent[] {
    const events: RemoteOperationEvent[] = [];
    if (op.type === 'insert') this.applyRemoteInsert(op, events);
    else this.applyRemoteDelete(op, events);
    this.drainBacklog(events);
    return events;
  }

  private applyRemoteInsert(op: InsertOp, events: RemoteOperationEvent[]): void {
    if (this.indexById.has(charIdKey(op.id))) return; // idempotent

    if (op.parentId !== null && !this.indexById.has(charIdKey(op.parentId))) {
      this.insertBacklog.push(op);
      const pk = charIdKey(op.parentId);
      if (!this.backlogByParent.has(pk)) this.backlogByParent.set(pk, []);
      this.backlogByParent.get(pk)!.push(op);
      return;
    }

    const preTombstoned = this.tombstonedIds.delete(charIdKey(op.id));
    const char: CRDTChar = {
      id: op.id,
      value: op.value,
      tombstone: preTombstoned,
      parentId: op.parentId,
    };
    const insertAt = this.findInsertSlot(op.parentId, op.id);
    this.spliceInsert(insertAt, char);

    if (!preTombstoned) {
      const visIdx = this.fenwickQuery(insertAt);
      events.push({ type: 'insert', index: visIdx, value: op.value });
    }
  }

  private applyRemoteDelete(op: DeleteOp, events: RemoteOperationEvent[]): void {
    const key = charIdKey(op.id);
    const idx = this.indexById.get(key);
    if (idx === undefined) {
      this.tombstonedIds.add(key);
      return;
    }
    const c = this.sequence[idx];
    if (c.tombstone) return;
    const visIdx = this.fenwickQuery(idx);
    c.tombstone = true;
    this.fenwickUpdate(idx, -1);
    events.push({ type: 'delete', index: visIdx, length: 1 });
  }

  /**
   * AUDIT FIX #3: O(b) drain via parent-indexed fan-out instead of O(b²)
   * repeated full-backlog scans.
   *
   * AUDIT FIX (dedup): replaced O(n) `queue.includes(op)` with an O(1)
   * Set membership check to avoid re-introducing quadratic behaviour.
   */
  private drainBacklog(events: RemoteOperationEvent[]): void {
    // Use a BFS queue seeded by all newly unblocked ops.
    const queue: InsertOp[] = [];
    // O(1) membership guard — avoids the O(n) queue.includes() anti-pattern.
    const queued = new Set<InsertOp>();

    const enqueue = (op: InsertOp) => {
      if (!queued.has(op)) {
        queue.push(op);
        queued.add(op);
      }
    };

    // Collect ops whose parent is now known (or ROOT) from the backlog index.
    for (const [parentKey, ops] of this.backlogByParent.entries()) {
      if (parentKey === 'ROOT' || this.indexById.has(parentKey)) {
        for (const op of ops) enqueue(op);
        this.backlogByParent.delete(parentKey);
      }
    }
    // Also flush any that slipped through (legacy path / edge cases).
    const remaining: InsertOp[] = [];
    for (const op of this.insertBacklog) {
      const pk = op.parentId === null ? 'ROOT' : charIdKey(op.parentId);
      if (this.indexById.has(charIdKey(op.id))) continue; // already applied
      if (op.parentId === null || this.indexById.has(pk)) {
        enqueue(op);
      } else {
        remaining.push(op);
      }
    }
    this.insertBacklog = remaining;

    let i = 0;
    while (i < queue.length) {
      const op = queue[i++];
      if (this.indexById.has(charIdKey(op.id))) continue;
      this.applyRemoteInsert(op, events);
      // Fan out: any ops waiting on this newly applied op.
      const newKey = charIdKey(op.id);
      const waiting = this.backlogByParent.get(newKey);
      if (waiting) {
        for (const w of waiting) enqueue(w);
        this.backlogByParent.delete(newKey);
      }
    }
  }

  // ------------------------------------------------------------------
  // Internal positioning
  // ------------------------------------------------------------------

  private findInsertSlot(parentId: CharId | null, newId: CharId): number {
    let start = 0;
    if (parentId !== null) {
      const parentIdx = this.indexById.get(charIdKey(parentId));
      if (parentIdx === undefined) return this.sequence.length;
      start = parentIdx + 1;
    }

    let i = start;
    while (i < this.sequence.length) {
      const candidate = this.sequence[i];
      if (!charIdEquals(candidate.parentId, parentId)) {
        // Skip over sub-trees that descend from an earlier sibling.
        if (this.isDescendantOf(candidate, parentId)) {
          i++;
          continue;
        }
        break;
      }
      if (compareIds(newId, candidate.id) < 0) break;
      i++;
    }
    return i;
  }


  private isDescendantOf(char: CRDTChar, ancestorId: CharId | null): boolean {
    // Every node is a descendant of ROOT (null).
    if (ancestorId === null) return true;
    let cur: CharId | null = char.parentId;
    const visited = new Set<string>();
    while (cur !== null) {
      const k = charIdKey(cur);
      if (visited.has(k)) return false;
      visited.add(k);
      if (charIdEquals(cur, ancestorId)) return true;
      const idx = this.indexById.get(k);
      if (idx === undefined) return false;
      cur = this.sequence[idx].parentId;
    }
    return false;
  }


  private spliceInsert(rawIndex: number, char: CRDTChar): void {
    this.sequence.splice(rawIndex, 0, char);
    // Rebuild indexById from rawIndex onwards (splice shifts all later entries).
    for (let i = rawIndex; i < this.sequence.length; i++) {
      this.indexById.set(charIdKey(this.sequence[i].id), i);
    }

    const n = this.sequence.length;
    this.fenwick = new Array(n + 1).fill(0);
    for (let i = 0; i < n; i++) {
      if (!this.sequence[i].tombstone) {
        const j = i + 1; // 1-indexed
        this.fenwick[j] += 1;
        const parent = j + (j & -j);
        if (parent <= n) this.fenwick[parent] += this.fenwick[j];
      }
    }
  }

  private charAtVisible(visibleIndex: number): CRDTChar | null {
    if (visibleIndex < 0) return null;
    let count = -1;
    for (const c of this.sequence) {
      if (c.tombstone) continue;
      count++;
      if (count === visibleIndex) return c;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Fenwick tree helpers (1-indexed, prefix sum of visible chars)
  // ------------------------------------------------------------------

  private fenwickUpdate(rawIndex: number, delta: number): void {
    for (let i = rawIndex + 1; i <= this.fenwick.length - 1; i += i & -i) {
      this.fenwick[i] += delta;
    }
  }

  private fenwickQuery(rawIndex: number): number {
    let sum = 0;
    for (let i = rawIndex; i > 0; i -= i & -i) {
      sum += this.fenwick[i];
    }
    return sum;
  }
}
