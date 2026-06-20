import type { CharId } from './char.js';

export interface InsertOp {
  type: 'insert';
  id: CharId;
  value: string;
  parentId: CharId | null;
}

export interface DeleteOp {
  type: 'delete';
  id: CharId;
}

export type CRDTOperation = InsertOp | DeleteOp;
export type RemoteOperationEvent =
  | { type: 'insert'; index: number; value: string }
  | { type: 'delete'; index: number; length: number };
