/**
 * Fuzz & stress tests for the RGA CRDT.
 *
 * These complement the unit tests in rga.test.ts with:
 *  - Randomized concurrent insert/delete across N replicas
 *  - Large paste simulation (bulk insert)
 *  - Reconnect / late-delivery simulation
 *  - Property: all replicas must converge to identical text
 *
 * Run: pnpm test  (or jest directly in packages/crdt-core)
 */

import { RGA } from '../rga';
import type { CRDTOperation } from '../operation';

// Deterministic PRNG (mulberry32) so failures are reproducible.
function mkRng(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 0xffffffff;
  };
}

function randomString(rng: () => number, len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789 \n';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(rng() * chars.length)];
  return s;
}

// Apply all ops from `source` to every replica except source itself.
function broadcast(replicas: RGA[], ops: CRDTOperation[], source: RGA) {
  for (const r of replicas) {
    if (r === source) continue;
    for (const op of ops) r.applyRemote(op);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Property helper
// ──────────────────────────────────────────────────────────────────────────
function expectConvergence(replicas: RGA[]) {
  const texts = replicas.map((r) => r.getText());
  for (let i = 1; i < texts.length; i++) {
    expect(texts[i]).toBe(texts[0]);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe('RGA fuzz — randomized concurrent inserts', () => {
  for (let seed = 1; seed <= 10; seed++) {
    test(`seed=${seed}: 3 replicas, 50 random inserts each, must converge`, () => {
      const rng = mkRng(seed * 0xdeadbeef);
      const replicas = ['A', 'B', 'C'].map((id) => new RGA(id));
      const allOps: { ops: CRDTOperation[]; from: RGA }[] = [];

      // Each replica generates 50 random inserts independently.
      for (const r of replicas) {
        const myOps: CRDTOperation[] = [];
        for (let i = 0; i < 50; i++) {
          const vis = r.visibleLength();
          const idx = Math.floor(rng() * (vis + 1));
          const ch  = randomString(rng, 1);
          myOps.push(r.localInsert(idx, ch));
        }
        allOps.push({ ops: myOps, from: r });
      }

      // Deliver all ops to all other replicas (in original order per source).
      for (const { ops, from } of allOps) broadcast(replicas, ops, from);

      expectConvergence(replicas);
    });
  }
});

describe('RGA fuzz — concurrent inserts + deletes', () => {
  for (let seed = 1; seed <= 8; seed++) {
    test(`seed=${seed}: 2 replicas interleave inserts and deletes`, () => {
      const rng = mkRng(seed * 0xcafebabe);
      const [a, b] = ['A', 'B'].map((id) => new RGA(id));

      // Seed both with the same initial string.
      const init = 'hello world';
      const initOps: CRDTOperation[] = [];
      for (let i = 0; i < init.length; i++) {
        initOps.push(a.localInsert(i, init[i]));
      }
      for (const op of initOps) b.applyRemote(op);

      const opsFromA: CRDTOperation[] = [];
      const opsFromB: CRDTOperation[] = [];

      for (let i = 0; i < 40; i++) {
        // A: random insert or delete
        const aLen = a.visibleLength();
        if (aLen > 0 && rng() < 0.35) {
          const op = a.localDelete(Math.floor(rng() * aLen));
          if (op) opsFromA.push(op);
        } else {
          const op = a.localInsert(Math.floor(rng() * (aLen + 1)), randomString(rng, 1));
          opsFromA.push(op);
        }

        // B: random insert or delete
        const bLen = b.visibleLength();
        if (bLen > 0 && rng() < 0.35) {
          const op = b.localDelete(Math.floor(rng() * bLen));
          if (op) opsFromB.push(op);
        } else {
          const op = b.localInsert(Math.floor(rng() * (bLen + 1)), randomString(rng, 1));
          opsFromB.push(op);
        }
      }

      // Cross-deliver all ops.
      for (const op of opsFromA) b.applyRemote(op);
      for (const op of opsFromB) a.applyRemote(op);

      expectConvergence([a, b]);
    });
  }
});

describe('RGA fuzz — large paste (bulk insert)', () => {
  test('1000-character paste into two replicas converges', () => {
    const rng = mkRng(0xf00d1234);
    const [a, b] = ['A', 'B'].map((id) => new RGA(id));

    const pasteText = randomString(rng, 1000);
    const ops: CRDTOperation[] = [];
    for (let i = 0; i < pasteText.length; i++) {
      ops.push(a.localInsert(i, pasteText[i]));
    }
    for (const op of ops) b.applyRemote(op);

    expect(a.getText()).toBe(pasteText);
    expectConvergence([a, b]);
  });

  test('paste at random position while remote edits are in-flight', () => {
    const rng = mkRng(0x1234abcd);
    const [a, b] = ['A', 'B'].map((id) => new RGA(id));

    // Seed a short document.
    const seed = 'start ';
    const seedOps: CRDTOperation[] = seed.split('').map((c, i) => a.localInsert(i, c));
    for (const op of seedOps) b.applyRemote(op);

    // B inserts "PASTE" at position 3 while A simultaneously deletes a char.
    const pasteOps: CRDTOperation[] = [];
    'PASTE'.split('').forEach((c, i) => pasteOps.push(b.localInsert(3 + i, c)));
    const delOp = a.localDelete(2);

    for (const op of pasteOps) a.applyRemote(op);
    if (delOp) b.applyRemote(delOp);

    expectConvergence([a, b]);
  });
});

describe('RGA fuzz — late delivery / reconnect simulation', () => {
  test('ops delivered after a long offline period still converge', () => {
    const rng = mkRng(0xaabbccdd);
    const [a, b, c] = ['A', 'B', 'C'].map((id) => new RGA(id));

    // A and B sync in real-time for a while; C is "offline".
    const liveOps: CRDTOperation[] = [];
    for (let i = 0; i < 30; i++) {
      const len = a.visibleLength();
      const op  = a.localInsert(Math.floor(rng() * (len + 1)), randomString(rng, 1));
      liveOps.push(op);
      b.applyRemote(op);
    }

    // Meanwhile C has been editing independently.
    const cOps: CRDTOperation[] = [];
    for (let i = 0; i < 20; i++) {
      const len = c.visibleLength();
      const op  = c.localInsert(Math.floor(rng() * (len + 1)), randomString(rng, 1));
      cOps.push(op);
    }

    // C comes back online: delivers its backlog, receives all missed ops.
    for (const op of liveOps) c.applyRemote(op);
    for (const op of cOps) { a.applyRemote(op); b.applyRemote(op); }

    expectConvergence([a, b, c]);
  });

  test('duplicate / replayed ops are idempotent', () => {
    const [a, b] = ['A', 'B'].map((id) => new RGA(id));
    const ops: CRDTOperation[] = 'hello'.split('').map((c, i) => a.localInsert(i, c));

    // Deliver each op twice.
    for (const op of ops) { b.applyRemote(op); b.applyRemote(op); }

    expect(b.getText()).toBe('hello');
    expectConvergence([a, b]);
  });
});

describe('RGA fuzz — snapshot round-trip', () => {
  test('snapshot + initFromSnapshot preserves text and allows further ops', () => {
    const rng = mkRng(0x9999abcd);
    const a   = new RGA('A');
    for (let i = 0; i < 80; i++) {
      const len = a.visibleLength();
      a.localInsert(Math.floor(rng() * (len + 1)), randomString(rng, 1));
    }
    // Delete ~20% of chars.
    for (let i = 0; i < 16; i++) {
      const len = a.visibleLength();
      if (len > 0) a.localDelete(Math.floor(rng() * len));
    }

    const snap = { sequence: a.getSequence(), clock: a.clock };
    const b = new RGA('B', a.clock);
    b.initFromSnapshot(snap);

    expect(b.getText()).toBe(a.getText());

    // Both can continue editing and converge.
    const opA = a.localInsert(0, 'X');
    const opB = b.localInsert(0, 'Y');
    a.applyRemote(opB);
    b.applyRemote(opA);

    expectConvergence([a, b]);
  });
});
