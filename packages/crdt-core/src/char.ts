
export interface CharId {
  siteId: string;
  clock: number;
}

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

export function compareIds(a: CharId, b: CharId): number {
  if (a.siteId !== b.siteId) return a.siteId < b.siteId ? 1 : -1;
  return b.clock - a.clock;
}
