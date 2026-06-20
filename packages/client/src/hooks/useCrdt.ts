import { useCallback, useRef } from 'react';
import {
  RGA,
  type CRDTChar,
  type CRDTOperation,
  type RemoteOperationEvent,
} from '@crdts/crdt-core';

/**
 * Wraps one `RGA` instance per editor mount and exposes ergonomic
 * helpers for the Monaco binding.
 */
export function useCrdt(siteId: string) {
  const rgaRef = useRef<RGA>(new RGA(siteId));

  const initFromSnapshot = useCallback(
    (snapshot: { sequence: CRDTChar[]; clock?: number }) => {
      rgaRef.current.initFromSnapshot(snapshot);
      return rgaRef.current.getText();
    },
    [],
  );

  const localInsert = useCallback((index: number, value: string): CRDTOperation => {
    return rgaRef.current.localInsert(index, value);
  }, []);

  const localDelete = useCallback((index: number): CRDTOperation | null => {
    return rgaRef.current.localDelete(index);
  }, []);

  const applyRemote = useCallback(
    (op: CRDTOperation): RemoteOperationEvent[] => {
      return rgaRef.current.applyRemote(op);
    },
    [],
  );

  const getText = useCallback(() => rgaRef.current.getText(), []);

  return { rgaRef, initFromSnapshot, localInsert, localDelete, applyRemote, getText };
}
