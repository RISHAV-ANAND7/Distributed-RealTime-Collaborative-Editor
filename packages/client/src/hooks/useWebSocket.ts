import { useCallback, useEffect, useRef, useState } from 'react';
import { WS_URL } from '../lib/config';
import { getStoredToken } from '../lib/api';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface UseWebSocketOptions {
  url: string;
  onMessage: (msg: any) => void;
  enabled?: boolean;  // default true; set false to defer connection
}

const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_DELAY_MS = 400;
const MAX_QUEUE_SIZE = 500;

/**
 * Adds auth token as ?token= query param so the server can authenticate
 * WebSocket upgrade requests (WS protocol doesn't support custom headers
 * from browsers).
 */
function withToken(url: string): string {
  const token = getStoredToken();
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

export function useWebSocket({ url, onMessage, enabled = true }: UseWebSocketOptions) {
  const wsRef             = useRef<WebSocket | null>(null);
  const onMessageRef      = useRef(onMessage);
  const attemptsRef       = useRef(0);
  const closedManuallyRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const offlineQueueRef   = useRef<unknown[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');

  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);

  const flushQueue = useCallback((ws: WebSocket) => {
    while (offlineQueueRef.current.length > 0 && ws.readyState === WebSocket.OPEN) {
      const payload = offlineQueueRef.current.shift()!;
      ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    }
  }, []);

  useEffect(() => {
    if (!enabled || !url) return;  // don't connect until enabled
    closedManuallyRef.current = false;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      setStatus(attemptsRef.current === 0 ? 'connecting' : 'reconnecting');
      const ws = new WebSocket(withToken(url));
      wsRef.current = ws;

      ws.onopen = () => {
        attemptsRef.current = 0;
        setStatus('open');
        flushQueue(ws);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          onMessageRef.current?.(msg);
        } catch { /* ignore non-JSON */ }
      };

      ws.onerror = () => { /* handled by onclose */ };

      ws.onclose = () => {
        if (closedManuallyRef.current || cancelled) {
          setStatus('closed');
          return;
        }
        const base = Math.min(MAX_RECONNECT_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attemptsRef.current));
        const jitter = base * 0.25 * (Math.random() * 2 - 1);
        const delay = Math.max(100, Math.round(base + jitter));
        attemptsRef.current += 1;
        setStatus('reconnecting');
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      closedManuallyRef.current = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [url, flushQueue, enabled]);

  const send = useCallback((payload: unknown): boolean => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
      return true;
    }
    if (offlineQueueRef.current.length < MAX_QUEUE_SIZE) {
      offlineQueueRef.current.push(payload);
    }
    return false;
  }, []);

  const queueLength = offlineQueueRef.current.length;

  return { status, send, queueLength };
}

export function buildDocumentSocketUrl(docId: string): string {
  return `${WS_URL}/${docId}`;
}
