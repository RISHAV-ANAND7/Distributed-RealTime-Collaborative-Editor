/**
 * VersionHistory.tsx — version history sidebar panel
 *
 * Shows:
 *   - Total ops and contributor list (from /history)
 *   - Timeline slider over checkpoints
 *   - "Replay to this point" — fetches ops from 0 → selected seq
 *     and reconstructs the document text using a fresh RGA client-side
 *
 * The replay is read-only: it shows the text at that point in time
 * in a read-only Monaco instance. The user can dismiss to return to live.
 */

import { useState, useEffect, useCallback } from 'react';
import { History, X, Users, FileText, RotateCcw } from 'lucide-react';
import { API_URL } from '../lib/config';
import { RGA } from '@crdts/crdt-core';
import type { CRDTOperation } from '@crdts/crdt-core';

interface Contributor {
  userId: string;
  username: string;
  opCount: number;
}

interface Checkpoint {
  id: number;
  seq: number;
  appliedAt: number;
  opType: string;
  userId: string | null;
}

interface HistoryData {
  stats: {
    totalOps: number;
    firstOpAt: number | null;
    lastOpAt: number | null;
    contributors: Contributor[];
  };
  checkpoints: Checkpoint[];
}

interface VersionHistoryProps {
  docId: string;
  token: string;
  onClose: () => void;
  /** Called with replayed text when user selects a checkpoint */
  onPreviewText: (text: string | null) => void;
}

function formatRelTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function VersionHistory({ docId, token, onClose, onPreviewText }: VersionHistoryProps) {
  const [data, setData]         = useState<HistoryData | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [replaying, setReplaying] = useState(false);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`${API_URL}/documents/${docId}/history`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [docId, token]);

  const replayToSeq = useCallback(async (seq: number) => {
    setReplaying(true);
    setSelectedSeq(seq);
    try {
      // Fetch all ops up to (and including) the selected seq.
      const res = await fetch(
        `${API_URL}/documents/${docId}/history/replay?seq=0&limit=10000`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const { ops } = await res.json() as { ops: Array<{ op_json: string; seq: number }> };

      // Replay ops up to selected seq into a fresh RGA.
      const rga = new RGA('replay');
      for (const entry of ops) {
        if (entry.seq > seq) break;
        const op: CRDTOperation = JSON.parse(entry.op_json);
        rga.applyRemote(op);
      }
      onPreviewText(rga.getText());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setReplaying(false);
    }
  }, [docId, token, onPreviewText]);

  const clearPreview = () => {
    setSelectedSeq(null);
    onPreviewText(null);
  };

  if (loading) return (
    <div className="version-panel">
      <div className="version-panel-header">
        <History size={14} /> Version History
        <button className="version-close" onClick={onClose}><X size={14} /></button>
      </div>
      <div className="version-loading">Loading…</div>
    </div>
  );

  if (error) return (
    <div className="version-panel">
      <div className="version-panel-header">
        <History size={14} /> Version History
        <button className="version-close" onClick={onClose}><X size={14} /></button>
      </div>
      <div className="version-error">{error}</div>
    </div>
  );

  const { stats, checkpoints } = data!;

  return (
    <div className="version-panel">
      <div className="version-panel-header">
        <History size={14} /> Version History
        <button className="version-close" onClick={onClose}><X size={14} /></button>
      </div>

      {/* Stats summary */}
      <div className="version-stats">
        <div className="version-stat">
          <FileText size={12} />
          <span>{stats.totalOps.toLocaleString()} operations</span>
        </div>
        {stats.firstOpAt && (
          <div className="version-stat">
            <span>First edit {formatRelTime(stats.firstOpAt)}</span>
          </div>
        )}
      </div>

      {/* Contributors */}
      {stats.contributors.length > 0 && (
        <div className="version-section">
          <div className="version-section-title"><Users size={11} /> Contributors</div>
          {stats.contributors.map((c) => (
            <div key={c.userId} className="version-contributor">
              <span className="version-contrib-name">{c.username}</span>
              <span className="version-contrib-ops">{c.opCount} ops</span>
            </div>
          ))}
        </div>
      )}

      {/* Timeline */}
      {checkpoints.length > 0 && (
        <div className="version-section">
          <div className="version-section-title">Timeline</div>
          {selectedSeq !== null && (
            <button className="version-back-live" onClick={clearPreview}>
              <RotateCcw size={11} /> Back to live
            </button>
          )}
          <div className="version-timeline">
            {checkpoints.map((cp) => (
              <button
                key={cp.id}
                className={`version-cp ${selectedSeq === cp.seq ? 'version-cp-active' : ''}`}
                onClick={() => replayToSeq(cp.seq)}
                disabled={replaying}
                title={`Seq ${cp.seq} — ${formatRelTime(cp.appliedAt)}`}
              >
                <span className="version-cp-dot" />
                <span className="version-cp-label">
                  {formatRelTime(cp.appliedAt)}
                </span>
                <span className="version-cp-seq">#{cp.seq}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {checkpoints.length === 0 && (
        <div className="version-empty">No history yet. Start editing to build a timeline.</div>
      )}
    </div>
  );
}
