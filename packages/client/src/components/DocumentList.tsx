import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileText, Plus, Trash2, Users, ArrowUpRight, Loader2,
  ServerCrash, FolderOpen, RefreshCw, Clock,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { AuthModal } from './AuthModal';
import {
  createDocument,
  deleteDocument,
  listDocuments,
  type DocumentSummary,
} from '../lib/api';

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function DocumentList() {
  const navigate = useNavigate();
  const { token } = useAuth();

  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!token) return;

    try {
      const list = await listDocuments();
      setDocs(list);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Server unreachable');
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;

    refresh();
    const t = window.setInterval(refresh, 5000);
    return () => window.clearInterval(t);
  }, [refresh, token]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creating || !token) return;

    setCreating(true);
    try {
      const doc = await createDocument(newTitle.trim() || undefined);
      setNewTitle('');
      navigate(`/doc/${doc.id}`);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to create document');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!token) return;
    if (!confirm('Delete this document permanently?')) return;

    setDeletingId(id);
    try {
      await deleteDocument(id);
      setDocs((prev) => prev?.filter((d) => d.id !== id) ?? prev);
    } catch (err: any) {
      setError(err?.message ?? 'Delete failed');
    } finally {
      setDeletingId(null);
    }
  };

  if (!token) {
    return (
      <AuthModal
        onClose={() => {}}
        message="Please login or register first."
      />
    );
  }

  const liveCount = docs?.filter((d) => d.clients > 0).length ?? 0;

  return (
    <main className="home-page">
      <section className="hero-section">
        <div className="hero-eyebrow">
          <span className="hero-eyebrow-dot" />
          Real-time · Conflict-free · Local-first
        </div>

        <h1 className="hero-headline">
          Collaborate without<br />
          <span className="hero-accent">compromise.</span>
        </h1>

        <p className="hero-subline">
          Every edit propagates instantly across all peers. A custom{' '}
          <strong>Replicated Growable Array</strong> CRDT guarantees convergence —
          mathematically, not by luck.
        </p>

        <div className="hero-stats">
          <div className="stat-pill">
            <span className="stat-value">{docs?.length ?? '—'}</span>
            <span className="stat-label">documents</span>
          </div>
          <div className="stat-pill stat-pill-live">
            <span className="stat-dot-live" />
            <span className="stat-value">{liveCount}</span>
            <span className="stat-label">live</span>
          </div>
        </div>

        <form className="create-form" onSubmit={handleCreate}>
          <input
            ref={inputRef}
            className="create-input"
            placeholder="Document title (optional)"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            disabled={creating}
            maxLength={120}
            aria-label="New document title"
          />
          <button className="btn-create" type="submit" disabled={creating}>
            {creating
              ? <Loader2 size={15} className="spin" />
              : <Plus size={15} strokeWidth={2.5} />}
            {creating ? 'Creating…' : 'New document'}
          </button>
        </form>
      </section>

      <section className="docs-section">
        <header className="section-header">
          <div className="section-title-row">
            <FolderOpen size={15} strokeWidth={2} />
            <h2>All documents</h2>
            {docs && <span className="section-count">{docs.length}</span>}
          </div>
          <button className="btn-icon" onClick={refresh} title="Refresh" aria-label="Refresh documents">
            <RefreshCw size={13} />
          </button>
        </header>

        {error && (
          <div className="alert-error" role="alert">
            <ServerCrash size={16} />
            <div>
              <strong>Server unreachable</strong>
              <span className="alert-detail">backend on :3001 · {error}</span>
            </div>
          </div>
        )}

        {!docs && !error && (
          <div className="doc-grid">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="doc-card skeleton" />
            ))}
          </div>
        )}

        {docs?.length === 0 && !error && (
          <div className="empty-state">
            <div className="empty-icon"><FileText size={22} strokeWidth={1.5} /></div>
            <h3>No documents yet</h3>
            <p>Create your first collaborative doc above.</p>
          </div>
        )}

        {docs && docs.length > 0 && (
          <div className="doc-grid">
            {docs.map((d) => (
              <article
                key={d.id}
                className={`doc-card ${deletingId === d.id ? 'doc-card-deleting' : ''}`}
                onClick={() => navigate(`/doc/${d.id}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && navigate(`/doc/${d.id}`)}
                aria-label={`Open ${d.title}`}
              >
                <div className="doc-card-top">
                  <div className="doc-icon">
                    <FileText size={16} strokeWidth={1.8} />
                  </div>
                  <div className="doc-meta-right">
                    {d.clients > 0 && (
                      <span className="live-pill">
                        <span className="live-dot" />
                        {d.clients} online
                      </span>
                    )}
                  </div>
                </div>

                <h3 className="doc-title">{d.title}</h3>

                <div className="doc-footer">
                  <span className="doc-meta">
                    <Clock size={11} />
                    {formatRelative(d.lastModifiedAt ?? d.createdAt)}
                  </span>
                  <span className="doc-meta">
                    <Users size={11} />
                    {d.length.toLocaleString()} chars
                  </span>
                </div>

                <div className="doc-card-actions">
                  <button
                    className="doc-open-btn"
                    onClick={() => navigate(`/doc/${d.id}`)}
                    aria-label={`Open ${d.title}`}
                  >
                    Open <ArrowUpRight size={12} />
                  </button>
                  <button
                    className="doc-delete-btn"
                    onClick={(e) => handleDelete(e, d.id)}
                    aria-label={`Delete ${d.title}`}
                    title="Delete"
                  >
                    {deletingId === d.id
                      ? <Loader2 size={13} className="spin" />
                      : <Trash2 size={13} />}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="how-section">
        <h2 className="how-title">How it works</h2>
        <div className="how-grid">
          {[
            { step: '01', title: 'Type locally', desc: 'Edits apply to your RGA replica instantly — zero network round-trip needed.' },
            { step: '02', title: 'Stream ops', desc: 'Each insert/delete is a tiny causally-tagged operation sent over WebSocket.' },
            { step: '03', title: 'Always converge', desc: 'Every replica merges ops in any order. The math guarantees identical text.' },
          ].map(({ step, title, desc }) => (
            <div key={step} className="how-card">
              <span className="how-step">{step}</span>
              <h3>{title}</h3>
              <p>{desc}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}