import { useCallback, useEffect, useRef, useState } from 'react';
import { WS_URL, API_URL } from '../lib/config';
import { getStoredToken } from '../lib/api';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface UseWebSocketOptions {
  url: string;
  onMessage: (msg: any) => void;
  enabled?: boolean;       // default true; set false to defer connection
  /** Ref whose .current always holds the last confirmed server seq. */
  lastSeqRef?: React.RefObject<number>;
}

const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_DELAY_MS = 400;
const MAX_QUEUE_SIZE = 500;

/**
 * Fetch a one-time WS ticket from the server (/auth/ws-ticket).
 * The ticket is a short-lived opaque token that avoids putting the JWT in
 * the WebSocket URL (where it would appear in server/proxy access logs).
 * Falls back to the raw JWT if the ticket endpoint is unavailable.
 */
async function fetchWsTicket(): Promise<string | null> {
  const token = getStoredToken();
  if (!token) return null;
  try {
    const res = await fetch(`${API_URL}/auth/ws-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`ticket endpoint returned ${res.status}`);
    const { ticket } = await res.json();
    return typeof ticket === 'string' ? ticket : null;
  } catch {
    // Graceful fallback: use raw JWT (legacy behaviour).
    return null;
  }
}

/**
 * Build the authenticated WS URL.
 * Prefers ?ticket= (one-time, not logged); falls back to ?token= (JWT).
 */
async function buildAuthUrl(baseUrl: string, lastSeq: number): Promise<string> {
  const sep = baseUrl.includes('?') ? '&' : '?';
  let authParam: string;
  const ticket = await fetchWsTicket();
  if (ticket) {
    authParam = `ticket=${encodeURIComponent(ticket)}`;
  } else {
    // Fallback: raw JWT (supported by legacy extractWsToken path on server).
    const token = getStoredToken();
    authParam = token ? `token=${encodeURIComponent(token)}` : '';
  }
  const seqParam = lastSeq > 0 ? `&lastSeq=${lastSeq}` : '';
  return `${baseUrl}${sep}${authParam}${seqParam}`;
}

export function useWebSocket({ url, onMessage, enabled = true, lastSeqRef }: UseWebSocketOptions) {
  const wsRef             = useRef<WebSocket | null>(null);
  const onMessageRef      = useRef(onMessage);
  const attemptsRef       = useRef(0);
  const closedManuallyRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const offlineQueueRef   = useRef<unknown[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  // Reactive queue length — updated whenever items are added/removed.
  const [queueLength, setQueueLength] = useState(0);

  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);

  const flushQueue = useCallback((ws: WebSocket) => {
    while (offlineQueueRef.current.length > 0 && ws.readyState === WebSocket.OPEN) {
      const payload = offlineQueueRef.current.shift()!;
      ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    }
    setQueueLength(offlineQueueRef.current.length);
  }, []);

  useEffect(() => {
    if (!enabled || !url) return;  // don't connect until enabled
    closedManuallyRef.current = false;
    let cancelled = false;

    const connect = async () => {
      if (cancelled) return;
      setStatus(attemptsRef.current === 0 ? 'connecting' : 'reconnecting');
      const lastSeq = lastSeqRef?.current ?? 0;
      const authUrl = await buildAuthUrl(url, lastSeq);
      if (cancelled) return;
      const ws = new WebSocket(authUrl);
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
        reconnectTimerRef.current = window.setTimeout(() => void connect(), delay);
      };
    };

    void connect();

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
  }, [url, flushQueue, enabled, lastSeqRef]);

  const send = useCallback((payload: unknown): boolean => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
      return true;
    }
    if (offlineQueueRef.current.length < MAX_QUEUE_SIZE) {
      offlineQueueRef.current.push(payload);
      setQueueLength(offlineQueueRef.current.length);
    }
    return false;
  }, []);

  return { status, send, queueLength };
}

export function buildDocumentSocketUrl(docId: string): string {
  return `${WS_URL}/${docId}`;
}
