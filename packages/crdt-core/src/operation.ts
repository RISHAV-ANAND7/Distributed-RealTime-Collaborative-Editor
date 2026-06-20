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

/**
 * Event emitted by RGA.applyRemote() so that bindings (e.g. Monaco) can
 * apply surgical, range-based edits rather than re-rendering the buffer.
 */
export type RemoteOperationEvent =
  | { type: 'insert'; index: number; value: string }
  | { type: 'delete'; index: number; length: number };
