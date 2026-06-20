import { useState, useRef, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Zap, LogOut, ChevronDown, User } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

export function TopBar() {
  const location = useLocation();
  const isEditor = location.pathname.startsWith('/doc/');
  const { user, logout } = useAuth();

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <span className="brand-mark" aria-hidden>
          <svg viewBox="0 0 36 36" width="26" height="26" fill="none">
            <rect width="36" height="36" rx="10" fill="url(#tg)"/>
            <path d="M10 13h16M10 18h11M10 23h16" stroke="#fff" strokeWidth="2.4" strokeLinecap="round"/>
            <defs>
              <linearGradient id="tg" x1="0" y1="0" x2="36" y2="36">
                <stop offset="0%" stopColor="#4f46e5"/>
                <stop offset="100%" stopColor="#0891b2"/>
              </linearGradient>
            </defs>
          </svg>
        </span>
        <span className="brand-name">Confluence</span>
        <span className="brand-chip">
          <Zap size={9} strokeWidth={2.5}/> RGA·CRDT
        </span>
      </Link>

      <nav className="topbar-actions">
        {!isEditor && (
          <a
            className="topbar-link"
            href="https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type"
            target="_blank"
            rel="noreferrer"
          >
            What is CRDT?
          </a>
        )}

        {/* User menu */}
        {user && (
          <div className="topbar-user-menu" ref={menuRef}>
            <button
              className="topbar-user-btn"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="User menu"
              aria-expanded={menuOpen}
            >
              <span className="topbar-user-avatar">
                {user.username[0]?.toUpperCase()}
              </span>
              <span className="topbar-username">{user.username}</span>
              <ChevronDown
                size={12}
                style={{ opacity: 0.6, transform: menuOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
              />
            </button>

            {menuOpen && (
              <div className="topbar-dropdown" role="menu">
                <div className="topbar-dropdown-header">
                  <User size={12} style={{ opacity: 0.5 }} />
                  <span>{user.username}</span>
                </div>
                <div className="topbar-dropdown-divider" />
                <button
                  className="topbar-dropdown-item topbar-logout-item"
                  onClick={() => { logout(); setMenuOpen(false); }}
                  role="menuitem"
                >
                  <LogOut size={13} />
                  Sign out
                </button>
              </div>
            )}
          </div>
        )}
      </nav>
    </header>
  );
}
