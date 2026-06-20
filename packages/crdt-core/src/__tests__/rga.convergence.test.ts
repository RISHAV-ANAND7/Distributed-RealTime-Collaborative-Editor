/**
 * rga.convergence.test.ts — convergence proof tests
 *
 * These tests assert the core CRDT guarantee:
 *   For any set of operations applied in any order across any number of
 *   replicas, all replicas must converge to identical text.
 *
 * Test categories:
 *   1. Concurrent random insert/delete — randomized op interleaving
 *   2. Multi-client concurrent edits  — 5 clients, simultaneous ops
 *   3. Offline-then-reconnect         — partition, independent edits, merge
 *   4. Duplicate op idempotency       — same op applied N times
 *   5. Reconnect delta reconciliation — partial op log replay
 *   6. Large concurrent paste         — bulk inserts from multiple replicas
 *   7. Delete-before-insert (backlog) — delete arrives before the target char
 *   8. Tombstone stability            — heavy delete-heavy convergence
 */

import { RGA } from '../rga';
import type { CRDTOperation } from '../operation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) for reproducible failures. */
function mkRng(seed: number) {
  return (): number => {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 0xffffffff;
  };
}

function randomChar(rng: () => number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789 ';
  return chars[Math.floor(rng() * chars.length)];
}

/** Apply all ops to every replica in the given order. */
function applyAll(replicas: RGA[], ops: CRDTOperation[]): void {
  for (const r of replicas) {
    for (const op of ops) r.applyRemote(op);
  }
}

/** Assert every replica has the same text. */
function assertConvergence(replicas: RGA[], label?: string): void {
  const texts = replicas.map((r) => r.getText());
  for (let i = 1; i < texts.length; i++) {
    expect(texts[i]).toBe(texts[0]);
    if (texts[i] !== texts[0] && label) {
      throw new Error(
        `[${label}] replica ${i} diverged:\n  0: ${texts[0]}\n  ${i}: ${texts[i]}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Concurrent random insert/delete (many seeds)
// ---------------------------------------------------------------------------

describe('Convergence: random concurrent inserts + deletes', () => {
  for (let seed = 1; seed <= 15; seed++) {
    test(`seed=${seed}: 3 replicas, 40 random ops each (insert+delete)`, () => {
      const rng = mkRng(seed * 0xdeadbeef);
      const replicas = ['A', 'B', 'C'].map((id) => new RGA(id));
      const opsByReplica: CRDTOperation[][] = replicas.map(() => []);

      for (let ri = 0; ri < replicas.length; ri++) {
        const r = replicas[ri];
        for (let i = 0; i < 40; i++) {
          const len = r.visibleLength();
          if (len > 0 && rng() < 0.35) {
            const idx = Math.floor(rng() * len);
            const op = r.localDelete(idx);
            if (op) opsByReplica[ri].push(op);
          } else {
            const idx = Math.floor(rng() * (len + 1));
            opsByReplica[ri].push(r.localInsert(idx, randomChar(rng)));
          }
        }
      }

      // Cross-apply: every replica receives every other replica's ops.
      for (let ri = 0; ri < replicas.length; ri++) {
        for (let rj = 0; rj < replicas.length; rj++) {
          if (ri === rj) continue;
          applyAll([replicas[ri]], opsByReplica[rj]);
        }
      }

      assertConvergence(replicas, `seed=${seed}`);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Multi-client concurrent edits (5 clients)
// ---------------------------------------------------------------------------

describe('Convergence: 5 concurrent clients', () => {
  test('all 5 replicas converge after full op exchange', () => {
    const rng = mkRng(0xcafe);
    const replicas = ['A', 'B', 'C', 'D', 'E'].map((id) => new RGA(id));
    const allOps: { from: number; op: CRDTOperation }[] = [];

    for (let ri = 0; ri < replicas.length; ri++) {
      const r = replicas[ri];
      for (let i = 0; i < 30; i++) {
        const len = r.visibleLength();
        const idx = Math.floor(rng() * (len + 1));
        const op = r.localInsert(idx, randomChar(rng));
        allOps.push({ from: ri, op });
      }
    }

    // Each replica receives ops from all other replicas.
    for (const { from, op } of allOps) {
      for (let ri = 0; ri < replicas.length; ri++) {
        if (ri !== from) replicas[ri].applyRemote(op);
      }
    }

    assertConvergence(replicas, '5-clients');
    // Sanity: total visible chars = 5 × 30 (no deletes).
    expect(replicas[0].visibleLength()).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// 3. Offline-then-reconnect (partition + merge)
// ---------------------------------------------------------------------------

describe('Convergence: offline partition then reconnect', () => {
  test('partition into 2 groups, independent edits, then full merge converges', () => {
    const rng = mkRng(0xbeef);

    // Shared initial state: "hello"
    const origin = new RGA('origin');
    const initialOps: CRDTOperation[] = [];
    'hello'.split('').forEach((ch, i) => initialOps.push(origin.localInsert(i, ch)));

    // 3 replicas sync the initial state.
    const [A, B, C] = ['A', 'B', 'C'].map((id) => {
      const r = new RGA(id);
      applyAll([r], initialOps);
      return r;
    });
    expect(A.getText()).toBe('hello');

    // -- PARTITION: A+B are online together, C goes offline --

    const ab_ops: CRDTOperation[] = [];
    // A inserts " world" at end.
    ' world'.split('').forEach((ch) => {
      ab_ops.push(A.localInsert(A.visibleLength(), ch));
    });
    applyAll([B], ab_ops);

    // B deletes the 'h'.
    const b_del = B.localDelete(0);
    expect(b_del).not.toBeNull();
    ab_ops.push(b_del!);
    applyAll([A], [b_del!]);

    // -- C was offline, does independent edits --
    const c_ops: CRDTOperation[] = [];
    c_ops.push(C.localInsert(5, '!')); // "hello!"
    c_ops.push(C.localInsert(0, 'X')); // "Xhello!"

    // -- RECONNECT: all replicas exchange all ops --
    applyAll([A, B], c_ops);
    applyAll([C], ab_ops);

    assertConvergence([A, B, C], 'offline-reconnect');
  });

  test('client re-applies its own offline queue without diverging (idempotent)', () => {
    const A = new RGA('A');
    const B = new RGA('B');

    const ops: CRDTOperation[] = [];
    ops.push(A.localInsert(0, 'x'));
    ops.push(A.localInsert(1, 'y'));

    // B receives ops once.
    applyAll([B], ops);
    // B receives the same ops again (simulating client retransmit after reconnect).
    applyAll([B], ops);

    expect(A.getText()).toBe(B.getText());
  });
});

// ---------------------------------------------------------------------------
// 4. Duplicate op idempotency
// ---------------------------------------------------------------------------

describe('Idempotency: duplicate ops', () => {
  test('applying same insert op N times produces same result as once', () => {
    const A = new RGA('A');
    const B = new RGA('B');
    const op = A.localInsert(0, 'z');

    for (let i = 0; i < 10; i++) B.applyRemote(op);

    expect(B.getText()).toBe('z');
    expect(A.getText()).toBe(B.getText());
  });

  test('applying same delete op N times does not throw or corrupt state', () => {
    const A = new RGA('A');
    const B = new RGA('B');
    const ins = A.localInsert(0, 'k');
    applyAll([B], [ins]);
    const del = A.localDelete(0);
    expect(del).not.toBeNull();

    for (let i = 0; i < 5; i++) {
      A.applyRemote(del!);
      B.applyRemote(del!);
    }

    expect(A.getText()).toBe('');
    expect(B.getText()).toBe('');
  });

  test('concurrent concurrent inserts at same position are idempotent', () => {
    const rng = mkRng(42);
    const replicas = [new RGA('A'), new RGA('B'), new RGA('C')];

    // All three insert at index 0 concurrently.
    const ops = replicas.map((r) => r.localInsert(0, randomChar(rng)));

    // Apply all to all replicas (including double-applying own ops).
    for (const r of replicas) {
      for (const op of ops) r.applyRemote(op);
    }

    assertConvergence(replicas, 'concurrent-at-same-position');
    // Each visible char inserted exactly once: 3 chars.
    expect(replicas[0].visibleLength()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 5. Reconnect delta reconciliation
// ---------------------------------------------------------------------------

describe('Reconnect delta: partial replay from seq', () => {
  test('client receiving only delta ops catches up to full-sync state', () => {
    // Simulate server state: 10 ops applied.
    const server = new RGA('server');
    const allOps: CRDTOperation[] = [];
    for (let i = 0; i < 10; i++) allOps.push(server.localInsert(i, String.fromCharCode(97 + i)));

    // Client A synced at op 5 (seq=5).
    const clientA = new RGA('clientA');
    applyAll([clientA], allOps.slice(0, 5));

    // Client A receives delta (ops 6–10).
    applyAll([clientA], allOps.slice(5));

    expect(clientA.getText()).toBe(server.getText());
  });
});

// ---------------------------------------------------------------------------
// 6. Large concurrent paste (bulk insert)
// ---------------------------------------------------------------------------

describe('Convergence: large concurrent paste', () => {
  test('two replicas paste 200 chars each simultaneously then converge', () => {
    const rng = mkRng(0x1234);
    const A = new RGA('A');
    const B = new RGA('B');

    const aOps: CRDTOperation[] = [];
    const bOps: CRDTOperation[] = [];

    // A pastes 200 chars at position 0.
    for (let i = 0; i < 200; i++) aOps.push(A.localInsert(i, randomChar(rng)));
    // B pastes 200 chars at position 0 concurrently.
    for (let i = 0; i < 200; i++) bOps.push(B.localInsert(i, randomChar(rng)));

    applyAll([A], bOps);
    applyAll([B], aOps);

    assertConvergence([A, B], 'large-paste');
    expect(A.visibleLength()).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 7. Delete-before-insert (backlog drain)
// ---------------------------------------------------------------------------

describe('Out-of-order delivery: delete arrives before insert target', () => {
  test('delete for unseen char queued, char later applied, both converge', () => {
    const A = new RGA('A');
    const B = new RGA('B');

    // A inserts a char.
    const insOp = A.localInsert(0, 'Q');
    // A immediately deletes it.
    const delOp = A.localDelete(0);
    expect(delOp).not.toBeNull();

    // B receives delete FIRST (char not yet known → backlog).
    B.applyRemote(delOp!);
    // B then receives the insert.
    B.applyRemote(insOp);

    expect(A.getText()).toBe('');
    expect(B.getText()).toBe('');
  });

  test('chain of 5 out-of-order inserts still converge', () => {
    const A = new RGA('A');
    const B = new RGA('B');

    const ops: CRDTOperation[] = [];
    ops.push(A.localInsert(0, 'a'));
    ops.push(A.localInsert(1, 'b'));
    ops.push(A.localInsert(2, 'c'));
    ops.push(A.localInsert(3, 'd'));
    ops.push(A.localInsert(4, 'e'));

    // B receives in reverse order (e, d, c, b, a).
    for (const op of [...ops].reverse()) B.applyRemote(op);

    expect(B.getText()).toBe('abcde');
    assertConvergence([A, B]);
  });
});

// ---------------------------------------------------------------------------
// 8. Heavy delete convergence (tombstone stability)
// ---------------------------------------------------------------------------

describe('Convergence: heavy concurrent delete', () => {
  test('two replicas delete different halves of same string and converge', () => {
    const rng = mkRng(0xdead);
    const A = new RGA('A');
    const origin = new RGA('origin');

    // Insert 20 chars.
    const insOps: CRDTOperation[] = [];
    for (let i = 0; i < 20; i++) insOps.push(origin.localInsert(i, randomChar(rng)));
    applyAll([A], insOps);
    const B = new RGA('B');
    applyAll([B], insOps);

    // A deletes chars 0–9.
    const aDelOps: CRDTOperation[] = [];
    for (let i = 9; i >= 0; i--) {
      const op = A.localDelete(i);
      if (op) aDelOps.push(op);
    }

    // B deletes chars 10–19.
    const bDelOps: CRDTOperation[] = [];
    for (let i = B.visibleLength() - 1; i >= 10; i--) {
      const op = B.localDelete(i);
      if (op) bDelOps.push(op);
    }

    applyAll([A], bDelOps);
    applyAll([B], aDelOps);

    assertConvergence([A, B], 'heavy-delete');
    expect(A.visibleLength()).toBe(0);
  });

  test('3 replicas: one inserts, one deletes all, third receives in random order', () => {
    const rng = mkRng(0x5eed);
    const [A, B, C] = ['A', 'B', 'C'].map((id) => new RGA(id));

    // A inserts 10 chars.
    const insOps: CRDTOperation[] = [];
    for (let i = 0; i < 10; i++) insOps.push(A.localInsert(i, randomChar(rng)));
    applyAll([B], insOps);

    // B deletes all 10.
    const delOps: CRDTOperation[] = [];
    for (let i = 9; i >= 0; i--) {
      const op = B.localDelete(i);
      if (op) delOps.push(op);
    }
    applyAll([A], delOps);

    // C receives all ops in shuffled order.
    const combined = [...insOps, ...delOps];
    // Fisher-Yates shuffle.
    for (let i = combined.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [combined[i], combined[j]] = [combined[j], combined[i]];
    }
    applyAll([C], combined);

    assertConvergence([A, B, C], 'insert-delete-shuffle');
    expect(A.visibleLength()).toBe(0);
  });
});
