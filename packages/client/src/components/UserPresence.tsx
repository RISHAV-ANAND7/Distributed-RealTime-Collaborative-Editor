import { Users } from 'lucide-react';

export interface PresenceUser {
  siteId: string;
  name: string;
  color: string;
  position?: number;
  isMe?: boolean;
  typing?: boolean;
}

export function UserPresence({ users }: { users: PresenceUser[] }) {
  return (
    <section className="presence-panel" aria-label="Active editors">
      <div className="presence-header">
        <Users size={13} strokeWidth={2} />
        <span>Collaborators</span>
        <span className="presence-badge">{users.length}</span>
      </div>
      <ul className="presence-list" role="list">
        {users.map((u) => (
          <li key={u.siteId} className="presence-row">
            <span
              className="presence-avatar"
              style={{ background: u.color }}
              aria-label={u.name}
            >
              {u.name[0]?.toUpperCase() ?? '?'}
            </span>
            <div className="presence-info">
              <span className="presence-name">
                {u.name}
                {u.isMe && <span className="presence-you">you</span>}
              </span>
              <span className="presence-status">
                {u.typing && !u.isMe ? (
                  <>
                    <span className="typing-dots" aria-label="typing">
                      <span />
                      <span />
                      <span />
                    </span>
                    <span className="presence-typing-text">typing…</span>
                  </>
                ) : (
                  <>
                    <span className="presence-dot" style={{ background: u.color }} />
                    {u.isMe ? 'editing' : 'online'}
                  </>
                )}
              </span>
            </div>
          </li>
        ))}
        {users.length === 0 && (
          <li className="presence-empty">No one here yet</li>
        )}
      </ul>
    </section>
  );
}
