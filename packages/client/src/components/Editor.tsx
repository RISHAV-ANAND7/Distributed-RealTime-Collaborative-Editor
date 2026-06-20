import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MonacoEditor, { type OnMount } from '@monaco-editor/react';
import type { editor as MonacoNS } from 'monaco-editor';
import type { CRDTChar, CRDTOperation } from '@crdts/crdt-core';
import { useCrdt } from '../hooks/useCrdt';
import { useAuth } from '../hooks/useAuth';
import { useWebSocket, buildDocumentSocketUrl } from '../hooks/useWebSocket';
import {
  getOrCreateTabSiteId, getEffectiveDisplayName,
  getUserColor, getStoredName,
  setUserName, setUserColor, PALETTE,
} from '../lib/identity';
import { StatusBadge } from './StatusBadge';
import { UserPresence, type PresenceUser } from './UserPresence';
import { JoinModal } from './JoinModal';
import { AuthModal } from './AuthModal';
import { ShareModal } from './ShareModal';
import type { PendingUser } from '../lib/api';
import {
  Share2, Languages, ChevronDown, Download, ChevronRight,
  WifiOff, Lock, Hourglass,
} from 'lucide-react';

interface RemotePresence {
  siteId: string;
  name: string;
  color: string;
  position: number;
  typing: boolean;
  lastSeen: number;
}

interface EditorProps {
  docId: string;
  onTitleResolved?: (title: string) => void;
}

const PRESENCE_TTL_MS   = 30_000;
const HEARTBEAT_MS      = 10_000; // send a ping every 10 s
const TYPING_TIMEOUT_MS = 3_000;  // clear typing flag after 3 s of inactivity

const LANGUAGE_OPTIONS = [
  { value: 'markdown',   label: 'Markdown' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'python',     label: 'Python' },
  { value: 'json',       label: 'JSON' },
  { value: 'html',       label: 'HTML' },
  { value: 'css',        label: 'CSS' },
  { value: 'sql',        label: 'SQL' },
  { value: 'plaintext',  label: 'Plain text' },
];

// Save-as format options
const EXPORT_FORMATS = [
  { ext: 'txt',  label: 'Plain Text (.txt)',       mime: 'text/plain' },
  { ext: 'md',   label: 'Markdown (.md)',           mime: 'text/markdown' },
  { ext: 'json', label: 'JSON (.json)',             mime: 'application/json' },
  { ext: 'html', label: 'HTML (.html)',             mime: 'text/html' },
  { ext: 'ts',   label: 'TypeScript (.ts)',         mime: 'text/plain' },
  { ext: 'py',   label: 'Python (.py)',             mime: 'text/plain' },
  { ext: 'sql',  label: 'SQL (.sql)',               mime: 'text/plain' },
  { ext: 'csv',  label: 'CSV (.csv)',               mime: 'text/csv' },
];

export function Editor({ docId, onTitleResolved }: EditorProps) {
  // Tab-stable siteId: survives React re-renders, unique per browser tab.
  const siteId = useMemo(() => getOrCreateTabSiteId(), []);

  // ---- Auth-sourced identity -------------------------------------------
  const { user, token } = useAuth();

  // Display name & color — persisted in localStorage / sessionStorage
  const sessionNameKey = `crdt.name.${docId}`;
  const sessionJoinedKey = `crdt.joined.${docId}`;

  const [userName, setUserNameState] = useState(() => {
    try {
      const sessionName = sessionStorage.getItem(sessionNameKey);
      if (sessionName) return sessionName;
    } catch {}
    return getEffectiveDisplayName(user?.username);
  });
  const [userColor, setUserColorState] = useState(() => getUserColor());

  // ---- JoinModal: always shown before connecting -------------------------
  // 'joined' becomes true only after the user submits JoinModal.
  // WS connects only when joined = true.
  const [joined, setJoined] = useState(() => {
    try { return sessionStorage.getItem(sessionJoinedKey) === 'true'; }
    catch { return false; }
  });

  const handleJoin = (name: string, color: string) => {
    setUserName(name);
    setUserColor(color);
    setUserNameState(name);
    setUserColorState(color);
    setJoined(true);
    try {
      sessionStorage.setItem(sessionJoinedKey, 'true');
      sessionStorage.setItem(sessionNameKey, name);
    } catch {}
  };

  const { initFromSnapshot, localInsert, localDelete, applyRemote, getText } = useCrdt(siteId);

  const editorRef      = useRef<MonacoNS.IStandaloneCodeEditor | null>(null);
  const monacoRef      = useRef<typeof import('monaco-editor') | null>(null);
  const isRemoteRef    = useRef(false);
  const decorationsRef = useRef<Map<string, string[]>>(new Map());
  const sendRef        = useRef<((p: unknown) => boolean) | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef    = useRef(false);

  const [hydrated, setHydrated]             = useState(false);
  const [charCount, setCharCount]           = useState(0);
  const [language, setLanguage]             = useState('markdown');
  const [langOpen, setLangOpen]             = useState(false);
  const [exportOpen, setExportOpen]         = useState(false);
  const [showShare, setShowShare]           = useState(false);
  const [role, setRole]                     = useState<'owner' | 'editor' | 'viewer' | null>(null);
  const [accessDenied, setAccessDenied]     = useState(false);
  const [isWaiting, setIsWaiting]           = useState(false);  // waiting room
  const [isRejected, setIsRejected]         = useState(false);  // rejected by owner
  const [pendingUsers, setPendingUsers]     = useState<PendingUser[]>([]);  // join requests for owner
  const [remotePresence, setRemotePresence] = useState<Record<string, RemotePresence>>({});

  // ---- WebSocket -------------------------------------------------------
  const handleMessage = useCallback(
    (msg: any) => {
      if (!msg || typeof msg !== 'object') return;

      // --- Waiting room messages ---
      if (msg.type === 'waiting') {
        setIsWaiting(true);
        return;
      }
      if (msg.type === 'approved') {
        setIsWaiting(false);
        if (msg.role) setRole(msg.role as 'owner' | 'editor' | 'viewer');
        return;
      }
      if (msg.type === 'rejected') {
        setIsWaiting(false);
        setIsRejected(true);
        return;
      }
      if (msg.type === 'join_request') {
        // Owner receives: someone is asking to join
        setPendingUsers((prev) => {
          if (prev.some((p) => p.userId === msg.userId)) return prev;
          return [...prev, {
            userId: msg.userId,
            username: msg.username,
            displayName: msg.displayName ?? msg.username,
          }];
        });
        return;
      }

      if (msg.type === 'sync') {
        const text = initFromSnapshot({
          sequence: (msg.sequence ?? []) as CRDTChar[],
          clock: msg.clock ?? 0,
        });
        if (msg.title) onTitleResolved?.(msg.title);
        const ed = editorRef.current;
        if (ed) {
          isRemoteRef.current = true;
          try { ed.setValue(text); }
          finally { isRemoteRef.current = false; }
        }
        setHydrated(true);
        setCharCount(text.length);
        // Persist our role from the server.
        if (msg.role) setRole(msg.role as 'owner' | 'editor' | 'viewer');
        // Announce presence to peers once synced.
        sendRef.current?.({ type: 'cursor', siteId, name: userName, color: userColor, position: 0, typing: false });
        return;
      }

      if (msg.type === 'error') {
        setAccessDenied(true);
        return;
      }

      if (msg.type === 'insert' || msg.type === 'delete') {
        const events = applyRemote(msg as CRDTOperation);
        if (!events.length) return;
        const ed = editorRef.current;
        const monaco = monacoRef.current;
        if (!ed || !monaco) return;
        const model = ed.getModel();
        if (!model) return;

        isRemoteRef.current = true;
        try {
          for (const ev of events) {
            if (ev.type === 'insert') {
              const pos = model.getPositionAt(ev.index);
              const range = new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column);
              ed.executeEdits('remote', [{ range, text: ev.value, forceMoveMarkers: true }]);
            } else {
              const start = model.getPositionAt(ev.index);
              const end   = model.getPositionAt(ev.index + ev.length);
              const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
              ed.executeEdits('remote', [{ range, text: '', forceMoveMarkers: true }]);
            }
          }
        } finally {
          isRemoteRef.current = false;
          setCharCount(getText().length);
        }
        return;
      }

      if (msg.type === 'cursor') {
        if (msg.siteId === siteId) return;
        setRemotePresence((prev) => ({
          ...prev,
          [msg.siteId]: {
            siteId: msg.siteId,
            name: msg.name ?? 'Anonymous',
            color: msg.color ?? PALETTE[0],
            position: typeof msg.position === 'number' ? msg.position : 0,
            typing: !!msg.typing,
            lastSeen: Date.now(),
          },
        }));
        return;
      }

      if (msg.type === 'heartbeat') {
        if (msg.siteId === siteId) return;
        setRemotePresence((prev) => {
          if (!prev[msg.siteId]) return prev;
          return { ...prev, [msg.siteId]: { ...prev[msg.siteId], lastSeen: Date.now() } };
        });
        return;
      }

      if (msg.type === 'leave') {
        setRemotePresence((prev) => {
          if (!prev[msg.siteId]) return prev;
          const next = { ...prev };
          delete next[msg.siteId];
          return next;
        });
      }
    },
    [applyRemote, getText, initFromSnapshot, onTitleResolved, siteId, userColor, userName],
  );

  // Build WS URL only after user has joined (picked a name).
  // Include the displayName as a query param so the server can see it.
  const wsUrl = useMemo(() => {
    if (!joined) return null;
    const base = buildDocumentSocketUrl(docId);
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}name=${encodeURIComponent(userName)}`;
  }, [docId, joined, userName]);

  const { status, send, queueLength } = useWebSocket({
    url: wsUrl ?? '',
    onMessage: handleMessage,
    enabled: joined,  // don't connect until user has joined
  });
  useEffect(() => { sendRef.current = send; }, [send]);

  // Heartbeat: tell peers we're still alive every HEARTBEAT_MS.
  useEffect(() => {
    const t = window.setInterval(() => {
      sendRef.current?.({
        type: 'heartbeat', siteId, name: userName, color: userColor,
      });
    }, HEARTBEAT_MS);
    return () => window.clearInterval(t);
  }, [siteId, userName, userColor]);

  // Cull stale presence entries (no heartbeat received within TTL).
  useEffect(() => {
    const t = window.setInterval(() => {
      setRemotePresence((prev) => {
        const cutoff = Date.now() - PRESENCE_TTL_MS;
        let changed = false;
        const next: Record<string, RemotePresence> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (v.lastSeen >= cutoff) next[k] = v;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 5000);
    return () => window.clearInterval(t);
  }, []);

  // ---- Monaco ----------------------------------------------------------
  const onMount: OnMount = (editor, monaco) => {
    editorRef.current  = editor;
    monacoRef.current  = monaco;

    editor.onDidChangeCursorPosition((e) => {
      const model = editor.getModel();
      if (!model) return;
      sendRef.current?.({
        type: 'cursor', siteId, name: userName, color: userColor,
        position: model.getOffsetAt(e.position),
        typing: isTypingRef.current,
      });
    });

    editor.onDidChangeModelContent((e) => {
      if (isRemoteRef.current) return;
      const model = editor.getModel();
      if (!model) return;

      // Mark self as typing and broadcast immediately
      if (!isTypingRef.current) {
        isTypingRef.current = true;
        sendRef.current?.({
          type: 'cursor', siteId, name: userName, color: userColor,
          position: model.getOffsetAt(editor.getPosition()!),
          typing: true,
        });
      }
      // Reset the typing timer
      if (typingTimerRef.current !== null) clearTimeout(typingTimerRef.current);
      typingTimerRef.current = setTimeout(() => {
        isTypingRef.current = false;
        typingTimerRef.current = null;
        const m = editorRef.current?.getModel();
        if (m) {
          sendRef.current?.({
            type: 'cursor', siteId, name: userName, color: userColor,
            position: m.getOffsetAt(editorRef.current!.getPosition()!),
            typing: false,
          });
        }
      }, TYPING_TIMEOUT_MS);

      const sorted = e.changes.slice().sort((a, b) => b.rangeOffset - a.rangeOffset);
      for (const change of sorted) {
        if (change.rangeLength > 0) {
          for (let i = 0; i < change.rangeLength; i++) {
            const op = localDelete(change.rangeOffset);
            if (op) send(op);
          }
        }
        if (change.text.length > 0) {
          const chars = Array.from(change.text);
          let idx = change.rangeOffset;
          for (const ch of chars) {
            const op = localInsert(idx, ch);
            send(op);
            idx++;
          }
        }
      }
      setCharCount(getText().length);
    });
  };

  // ---- Remote cursor decorations ---------------------------------------
  useEffect(() => {
    const ed     = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;
    const model = ed.getModel();
    if (!model) return;

    ensureCursorStyles(Object.values(remotePresence));
    const liveSiteIds = new Set(Object.keys(remotePresence));

    for (const [sid, ids] of decorationsRef.current.entries()) {
      if (!liveSiteIds.has(sid)) {
        ed.deltaDecorations(ids, []);
        decorationsRef.current.delete(sid);
      }
    }

    for (const p of Object.values(remotePresence)) {
      const safePos = Math.max(0, Math.min(p.position, model.getValueLength()));
      const pos     = model.getPositionAt(safePos);
      const range   = new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column);
      const cursorCls = `rc-cursor rc-cursor-${slug(p.siteId)}`;
      const labelCls  = `rc-label rc-label-${slug(p.siteId)}`;
      const prev = decorationsRef.current.get(p.siteId) ?? [];
      const next = ed.deltaDecorations(prev, [{
        range,
        options: {
          className: cursorCls,
          beforeContentClassName: labelCls,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      }]);
      decorationsRef.current.set(p.siteId, next);
    }
  }, [remotePresence, hydrated]);

  // ---- Presence list ---------------------------------------------------
  const presenceUsers: PresenceUser[] = useMemo(() => [
    { siteId, name: userName, color: userColor, isMe: true, typing: false },
    ...Object.values(remotePresence).map((p) => ({
      siteId: p.siteId, name: p.name, color: p.color, position: p.position, typing: p.typing,
    })),
  ], [remotePresence, siteId, userColor, userName]);

  // ---- Export / Save as ------------------------------------------------
  const handleExport = (fmt: typeof EXPORT_FORMATS[number]) => {
    const rawText = getText();
    let content = rawText;
    let mime = fmt.mime;

    if (fmt.ext === 'json') {
      // Wrap plain text in a simple JSON object
      content = JSON.stringify({ content: rawText }, null, 2);
    } else if (fmt.ext === 'html') {
      const escaped = rawText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      content = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Document</title></head>
<body><pre>${escaped}</pre></body>
</html>`;
    }

    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `document.${fmt.ext}`;
    a.click();
    URL.revokeObjectURL(url);
    setExportOpen(false);
  };

  const currentLangLabel = LANGUAGE_OPTIONS.find((l) => l.value === language)?.label ?? 'Markdown';

  // ---- Access denied overlay ------------------------------------------
  if (accessDenied) {
    return (
      <div className="access-denied-overlay">
        <div className="access-denied-card">
          <span className="access-denied-icon"><Lock size={32} /></span>
          <h2>Access Denied</h2>
          <p>You don't have permission to view this document.</p>
          <p className="access-denied-hint">
            Ask the document owner to invite you by username from the Share panel.
          </p>
          <a href="/" className="access-denied-home-btn">← Back to your documents</a>
        </div>
      </div>
    );
  }

  // ---- Auth check: must be logged in to join ---------------------------
  if (!token) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 99999 }}>
        <AuthModal
          onClose={() => {}}
          message="Please log in or register to join this document."
        />
      </div>
    );
  }

  // ---- Waiting room overlay --------------------------------------------
  if (isWaiting) {
    return (
      <div className="access-denied-overlay waiting-overlay">
        <div className="access-denied-card waiting-card">
          <span className="access-denied-icon waiting-icon"><Hourglass size={32} /></span>
          <h2>Waiting for Approval</h2>
          <p>The document owner has been notified of your request to join.</p>
          <p className="access-denied-hint">
            Please wait — the owner will approve or deny your request shortly.
          </p>
          <div className="waiting-spinner" />
        </div>
      </div>
    );
  }

  // ---- Rejected overlay ------------------------------------------------
  if (isRejected) {
    return (
      <div className="access-denied-overlay">
        <div className="access-denied-card">
          <span className="access-denied-icon"><Lock size={32} /></span>
          <h2>Request Denied</h2>
          <p>The document owner denied your request to join this document.</p>
          <a href="/" className="access-denied-home-btn">← Back to your documents</a>
        </div>
      </div>
    );
  }

  // ---- JoinModal: always shown before WS connects ----------------------
  if (!joined) {
    return (
      <JoinModal
        onJoin={handleJoin}
        defaultColor={userColor}
        defaultName={user?.username ?? ''}
      />
    );
  }

  return (
    <>
      {/* ---- Share modal ---- */}
      {showShare && (
        <ShareModal
          docId={docId}
          isOwner={role === 'owner'}
          pendingUsers={pendingUsers}
          onPendingResolved={(userId) => {
            setPendingUsers((prev) => prev.filter((p) => p.userId !== userId));
          }}
          onClose={() => setShowShare(false)}
        />
      )}

      <div className="editor-shell">
        {/* Toolbar */}
        <div className="editor-toolbar">
          <div className="editor-toolbar-left">
            <StatusBadge status={status} />
            {/* Offline queue indicator */}
            {queueLength > 0 && (
              <span className="offline-queue-badge" title={`${queueLength} op(s) queued — will sync on reconnect`}>
                <WifiOff size={11} />
                {queueLength} queued
              </span>
            )}
            <span className="char-count">{hydrated ? `${charCount.toLocaleString()} chars` : 'Loading…'}</span>
          </div>

          <div className="editor-toolbar-center">
            {/* Language picker */}
            <div className="lang-picker">
              <button
                className="lang-btn"
                onClick={() => { setLangOpen((v) => !v); setExportOpen(false); }}
                aria-label="Select language"
              >
                <Languages size={13} />
                {currentLangLabel}
                <ChevronDown size={11} style={{ opacity: 0.5 }} />
              </button>
              {langOpen && (
                <ul className="lang-dropdown" role="listbox">
                  {LANGUAGE_OPTIONS.map((l) => (
                    <li
                      key={l.value}
                      className={`lang-option ${language === l.value ? 'lang-option-active' : ''}`}
                      onClick={() => { setLanguage(l.value); setLangOpen(false); }}
                      role="option"
                      aria-selected={language === l.value}
                    >
                      {l.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Export / Save as */}
            <div className="lang-picker">
              <button
                className="lang-btn"
                onClick={() => { setExportOpen((v) => !v); setLangOpen(false); }}
                aria-label="Save as"
              >
                <Download size={13} />
                Save as
                <ChevronRight size={11} style={{ opacity: 0.5 }} />
              </button>
              {exportOpen && (
                <ul className="lang-dropdown" role="listbox">
                  {EXPORT_FORMATS.map((f) => (
                    <li
                      key={f.ext}
                      className="lang-option"
                      onClick={() => handleExport(f)}
                      role="option"
                    >
                      {f.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="editor-toolbar-right">
            <div className="avatar-row">
              {presenceUsers.slice(0, 6).map((u) => (
                <span
                  key={u.siteId}
                  className={`av ${u.isMe ? 'av-me' : ''}`}
                  style={{ background: u.color }}
                  title={u.name}
                >
                  {u.name[0].toUpperCase()}
                </span>
              ))}
              {presenceUsers.length > 6 && (
                <span className="av av-more">+{presenceUsers.length - 6}</span>
              )}
            </div>

            <button
              className="share-btn"
              onClick={() => setShowShare(true)}
              title="Share & invite collaborators"
            >
              <Share2 size={13} />
              Share
              {role === 'owner' && <span className="share-owner-dot" title="You are the owner" />}
              {pendingUsers.length > 0 && (
                <span className="share-pending-badge" title={`${pendingUsers.length} pending request(s)`}>
                  {pendingUsers.length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Main editor + sidebar */}
        <div className="editor-body">
          <div className="editor-canvas">
            <MonacoEditor
              height="100%"
              language={language}
              theme="vs-dark"
              onMount={onMount}
              options={{
                minimap:               { enabled: false },
                fontSize:              14,
                fontFamily:            "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
                fontLigatures:         true,
                wordWrap:              'on',
                lineNumbers:           'on',
                padding:               { top: 20, bottom: 20 },
                scrollBeyondLastLine:  false,
                renderLineHighlight:   'gutter',
                automaticLayout:       true,
                smoothScrolling:       true,
                cursorBlinking:        'smooth',
                cursorSmoothCaretAnimation: 'on',
                bracketPairColorization: { enabled: true },
                renderWhitespace:      'selection',
                scrollbar:             { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
                overviewRulerLanes:    0,
                hideCursorInOverviewRuler: true,
              }}
            />
          </div>

          <aside className="editor-sidebar">
            <UserPresence users={presenceUsers} />

            <div className="crdt-info-card">
              <div className="crdt-info-header">CRDT Info</div>
              <dl className="crdt-info-body">
                <dt>Algorithm</dt><dd>RGA</dd>
                <dt>Site ID</dt><dd className="mono-sm">{siteId.slice(0, 12)}…</dd>
                <dt>Peers</dt><dd>{presenceUsers.length - 1}</dd>
              </dl>
            </div>

            <div className="hint-card">
              <p>Open this URL in another tab and type simultaneously — changes reconcile automatically.</p>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '');
}

let injectedStyle: HTMLStyleElement | null = null;
function ensureCursorStyles(users: { siteId: string; color: string; name: string }[]) {
  if (typeof document === 'undefined') return;
  if (!injectedStyle) {
    injectedStyle = document.createElement('style');
    injectedStyle.setAttribute('data-crdt-cursors', 'true');
    document.head.appendChild(injectedStyle);
  }
  injectedStyle.textContent = users.map(({ siteId, color, name }) => {
    const id = slug(siteId);
    const safeName = name.replace(/["\\]/g, '');
    return `
      .rc-cursor-${id} { border-left: 2px solid ${color}; margin-left: -1px; }
      .rc-label-${id}::before {
        content: "${safeName}";
        background: ${color};
        color: #0a0c12;
        font-size: 10px;
        font-weight: 700;
        padding: 1px 6px;
        border-radius: 4px;
        position: absolute;
        transform: translate(-1px, -18px);
        white-space: nowrap;
        pointer-events: none;
        z-index: 100;
        font-family: var(--font-sans);
        letter-spacing: 0.02em;
      }
    `;
  }).join('\n');
}
