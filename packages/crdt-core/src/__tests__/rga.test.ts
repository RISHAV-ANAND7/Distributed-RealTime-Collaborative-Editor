import { RGA } from '../rga';
import type { CRDTOperation } from '../operation';

function syncAll(replicas: RGA[], ops: CRDTOperation[]) {
  for (const op of ops) {
    for (const r of replicas) r.applyRemote(op);
  }
}

describe('RGA — basic operations', () => {
  test('local insert produces visible text', () => {
    const r = new RGA('A');
    r.localInsert(0, 'h');
    r.localInsert(1, 'i');
    expect(r.getText()).toBe('hi');
  });

  test('local delete tombstones a character', () => {
    const r = new RGA('A');
    'cat'.split('').forEach((c, i) => r.localInsert(i, c));
    r.localDelete(1);
    expect(r.getText()).toBe('ct');
  });
});

describe('RGA — convergence', () => {
  test('two replicas converge under concurrent inserts at same position', () => {
    const a = new RGA('A');
    const b = new RGA('B');
    const opA = a.localInsert(0, 'X');
    const opB = b.localInsert(0, 'Y');
    a.applyRemote(opB);
    b.applyRemote(opA);
    expect(a.getText()).toBe(b.getText());
  });

  test('replicas converge when ops arrive in different orders', () => {
    const a = new RGA('A');
    const b = new RGA('B');
    const ops: CRDTOperation[] = [];
    ops.push(a.localInsert(0, 'a'));
    ops.push(a.localInsert(1, 'b'));
    ops.push(a.localInsert(2, 'c'));

    // B applies in reverse
    [...ops].reverse().forEach((o) => b.applyRemote(o));
    expect(b.getText()).toBe('abc');
  });

  test('concurrent deletes are idempotent', () => {
    const a = new RGA('A');
    const b = new RGA('B');
    const insert = a.localInsert(0, 'z');
    b.applyRemote(insert);
    const del = a.localDelete(0);
    expect(del).not.toBeNull();
    b.applyRemote(del!);
    b.applyRemote(del!); // duplicate
    expect(a.getText()).toBe('');
    expect(b.getText()).toBe('');
  });
});

describe('RGA — out-of-order delivery', () => {
  test('insert arriving before its parent is buffered then applied', () => {
    const a = new RGA('A');
    const b = new RGA('B');
    const op1 = a.localInsert(0, 'h');
    const op2 = a.localInsert(1, 'i');
    // deliver op2 to B *before* op1
    b.applyRemote(op2);
    expect(b.getText()).toBe('');
    b.applyRemote(op1);
    expect(b.getText()).toBe('hi');
  });

  test('delete arriving before its target is cached as a tombstone', () => {
    const a = new RGA('A');
    const b = new RGA('B');
    const op1 = a.localInsert(0, 'q');
    const op2 = a.localDelete(0);
    expect(op2).not.toBeNull();
    b.applyRemote(op2!); // before op1
    b.applyRemote(op1);
    expect(b.getText()).toBe('');
  });
});

describe('RGA — multi-replica convergence', () => {
  test('three replicas converge', () => {
    const a = new RGA('A');
    const b = new RGA('B');
    const c = new RGA('C');

    const ops: CRDTOperation[] = [];
    ops.push(a.localInsert(0, 'H'));
    ops.push(b.localInsert(0, 'i'));
    ops.push(c.localInsert(0, '!'));

    syncAll([a, b, c], ops);

    expect(a.getText()).toBe(b.getText());
    expect(b.getText()).toBe(c.getText());
  });
});
