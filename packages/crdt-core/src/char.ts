/**
 * Globally unique identifier for a CRDT character.
 * Composed of the originating site's identifier and a monotonically
 * increasing local logical clock value.
 */
export interface CharId {
  siteId: string;
  clock: number;
}

/**
 * A single character node in the Replicated Growable Array (RGA).
 *
 * - `id`        : unique identity used for causal references
 * - `value`     : visible character payload (a single grapheme in practice)
 * - `tombstone` : true once deleted; node is preserved for causal correctness
 * - `parentId`  : id of the character this one was inserted *after*
 *                 (null = inserted at the beginning of the document)
 */
export interface CRDTChar {
  id: CharId;
  value: string;
  tombstone: boolean;
  parentId: CharId | null;
}

export function charIdEquals(a: CharId | null, b: CharId | null): boolean {
  if (a === null || b === null) return a === b;
  return a.siteId === b.siteId && a.clock === b.clock;
}

export function charIdKey(id: CharId | null): string {
  if (id === null) return 'ROOT';
  return `${id.siteId}:${id.clock}`;
}

/**
 * Deterministic tie-breaker for two concurrent inserts that share a parent.
 * Returns < 0 if `a` should come *before* `b`, > 0 if after, 0 if equal.
 *
 * Ordering rule: higher (siteId, clock) sits closer to the parent
 * (i.e. earlier in the resulting sibling list). This matches the
 * classic RGA convention and gives a stable total order across replicas.
 */
export function compareIds(a: CharId, b: CharId): number {
  if (a.siteId !== b.siteId) return a.siteId < b.siteId ? 1 : -1;
  return b.clock - a.clock;
}
