/**
 * ShareModal.tsx — Rich share / invite modal
 *
 * Features:
 *  1. Copy document URL
 *  2. Invite collaborators by username (owner only)
 *  3. List current members with roles; owner can remove them
 */
import { useEffect, useRef, useState } from 'react';
import {
  X, Copy, Check, UserPlus, Crown, Pencil, Eye, Trash2, Loader2, Link2,
  CheckCircle2, XCircle,
} from 'lucide-react';
import {
  listMembers, inviteMember, revokeMember, approveUser, rejectUser,
  type Member, type PendingUser,
} from '../lib/api';

interface ShareModalProps {
  docId: string;
  isOwner: boolean;
  pendingUsers?: PendingUser[];
  onPendingResolved?: (userId: string) => void;
  onClose: () => void;
}

type InviteRole = 'editor' | 'viewer';

export function ShareModal({ docId, isOwner, pendingUsers = [], onPendingResolved, onClose }: ShareModalProps) {
  const [members, setMembers]         = useState<Member[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [membersError, setMembersError]     = useState('');

  // Invite form
  const [inviteUsername, setInviteUsername] = useState('');
  const [inviteRole, setInviteRole]         = useState<InviteRole>('editor');
  const [inviting, setInviting]             = useState(false);
  const [inviteSuccess, setInviteSuccess]   = useState('');
  const [inviteError, setInviteError]       = useState('');

  // Copy URL
  const [copied, setCopied] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const docUrl = window.location.href;

  // Load members on open
  useEffect(() => {
    loadMembers();
    setTimeout(() => inputRef.current?.focus(), 80);
  }, [docId]);

  async function loadMembers() {
    setLoadingMembers(true);
    setMembersError('');
    try {
      const list = await listMembers(docId);
      setMembers(list);
    } catch (err: any) {
      setMembersError(err.message ?? 'Failed to load members');
    } finally {
      setLoadingMembers(false);
    }
  }

  const handleCopy = () => {
    navigator.clipboard?.writeText(docUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    const username = inviteUsername.trim();
    if (!username) return;
    setInviting(true);
    setInviteError('');
    setInviteSuccess('');
    try {
      await inviteMember(docId, username, inviteRole);
      setInviteSuccess(`${username} invited as ${inviteRole}`);
      setInviteUsername('');
      await loadMembers();
    } catch (err: any) {
      setInviteError(err.message ?? 'Failed to invite');
    } finally {
      setInviting(false);
    }
  };

  const handleRemove = async (member: Member) => {
    if (!confirm(`Remove ${member.username} from this document?`)) return;
    try {
      await revokeMember(docId, member.userId);
      setMembers((prev) => prev.filter((m) => m.userId !== member.userId));
    } catch (err: any) {
      alert(err.message ?? 'Failed to remove member');
    }
  };

  const roleIcon = (role: string) => {
    if (role === 'owner') return <Crown size={11} className="role-icon-crown" />;
    if (role === 'editor') return <Pencil size={11} className="role-icon-editor" />;
    return <Eye size={11} className="role-icon-viewer" />;
  };

  return (
    <div
      className="share-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Share document"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="share-modal">
        {/* Header */}
        <div className="share-header">
          <div className="share-header-left">
            <span className="share-icon"><Link2 size={16} /></span>
            <div>
              <h2 className="share-title">Share document</h2>
              <p className="share-sub">Invite collaborators by their username</p>
            </div>
          </div>
          <button className="share-close-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {/* Copy link */}
        <div className="share-section">
          <label className="share-label">Document link</label>
          <div className="share-link-row">
            <input
              className="share-link-input"
              value={docUrl}
              readOnly
              aria-label="Document URL"
            />
            <button
              className={`share-copy-btn ${copied ? 'share-copy-btn-done' : ''}`}
              onClick={handleCopy}
              title="Copy link"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p className="share-hint">
            Share this link. Friends need to <strong>register an account</strong> and be invited below to edit.
          </p>
        </div>

        {/* Invite form — owners only */}
        {isOwner && (
          <div className="share-section">
            <label className="share-label">Invite collaborator</label>
            <form className="share-invite-form" onSubmit={handleInvite}>
              <input
                ref={inputRef}
                className="share-invite-input"
                placeholder="Username (e.g. shubham)"
                value={inviteUsername}
                onChange={(e) => {
                  setInviteUsername(e.target.value);
                  setInviteError('');
                  setInviteSuccess('');
                }}
                disabled={inviting}
                autoComplete="off"
                spellCheck={false}
                maxLength={32}
              />
              <div className="share-role-tabs" role="group" aria-label="Role">
                {(['editor', 'viewer'] as InviteRole[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={`share-role-tab ${inviteRole === r ? 'share-role-tab-active' : ''}`}
                    onClick={() => setInviteRole(r)}
                  >
                    {r === 'editor' ? <Pencil size={11} /> : <Eye size={11} />}
                    {r.charAt(0).toUpperCase() + r.slice(1)}
                  </button>
                ))}
              </div>
              <button
                className="share-invite-btn"
                type="submit"
                disabled={inviting || !inviteUsername.trim()}
              >
                {inviting
                  ? <Loader2 size={13} className="spin" />
                  : <UserPlus size={13} />}
                Invite
              </button>
            </form>

            {inviteSuccess && (
              <p className="share-feedback share-feedback-ok">
                <Check size={12} /> {inviteSuccess}
              </p>
            )}
            {inviteError && (
              <p className="share-feedback share-feedback-err">{inviteError}</p>
            )}
          </div>
        )}

        {/* Pending requests — owners only */}
        {isOwner && pendingUsers.length > 0 && (
          <div className="share-section">
            <label className="share-label">
              ⏳ Pending Requests
              <span className="share-count-badge share-pending-badge-inline">{pendingUsers.length}</span>
            </label>
            <ul className="share-members-list">
              {pendingUsers.map((p) => (
                <li key={p.userId} className="share-member-row share-pending-row">
                  <span
                    className="share-member-avatar"
                    style={{ background: avatarColor(p.displayName) }}
                  >
                    {p.displayName[0]?.toUpperCase()}
                  </span>
                  <div className="share-member-info">
                    <span className="share-member-name">{p.displayName}</span>
                    <span className="share-member-role share-role-pending">Waiting</span>
                  </div>
                  <button
                    className="share-approve-btn"
                    onClick={async () => {
                      try {
                        await approveUser(docId, p.userId, 'editor');
                        onPendingResolved?.(p.userId);
                        await loadMembers();
                      } catch {}
                    }}
                    title="Approve as Editor"
                  >
                    <CheckCircle2 size={14} />
                    Editor
                  </button>
                  <button
                    className="share-approve-btn share-approve-viewer"
                    onClick={async () => {
                      try {
                        await approveUser(docId, p.userId, 'viewer');
                        onPendingResolved?.(p.userId);
                        await loadMembers();
                      } catch {}
                    }}
                    title="Approve as Viewer"
                  >
                    <CheckCircle2 size={14} />
                    Viewer
                  </button>
                  <button
                    className="share-reject-btn"
                    onClick={async () => {
                      try {
                        await rejectUser(docId, p.userId);
                        onPendingResolved?.(p.userId);
                      } catch {}
                    }}
                    title="Reject request"
                  >
                    <XCircle size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Members list */}
        <div className="share-section share-section-last">
          <div className="share-members-header">
            <label className="share-label">
              Collaborators
              <span className="share-count-badge">{members.length}</span>
            </label>
          </div>

          {loadingMembers && (
            <div className="share-loading">
              <Loader2 size={14} className="spin" />
              Loading…
            </div>
          )}
          {membersError && (
            <p className="share-feedback share-feedback-err">{membersError}</p>
          )}

          {!loadingMembers && members.length === 0 && (
            <p className="share-no-members">No collaborators yet.</p>
          )}

          <ul className="share-members-list">
            {members.map((m) => (
              <li key={m.userId} className="share-member-row">
                <span
                  className="share-member-avatar"
                  style={{ background: avatarColor(m.username) }}
                >
                  {m.username[0]?.toUpperCase()}
                </span>
                <div className="share-member-info">
                  <span className="share-member-name">{m.username}</span>
                  <span className={`share-member-role share-role-${m.role}`}>
                    {roleIcon(m.role)}
                    {m.role}
                  </span>
                </div>
                {isOwner && m.role !== 'owner' && (
                  <button
                    className="share-member-remove"
                    onClick={() => handleRemove(m)}
                    title={`Remove ${m.username}`}
                    aria-label={`Remove ${m.username}`}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

// Deterministic avatar colour from username string
function avatarColor(name: string): string {
  const COLORS = [
    '#6366f1', '#06b6d4', '#f97316', '#10b981',
    '#f43f5e', '#a855f7', '#eab308', '#ec4899',
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return COLORS[Math.abs(h) % COLORS.length];
}
