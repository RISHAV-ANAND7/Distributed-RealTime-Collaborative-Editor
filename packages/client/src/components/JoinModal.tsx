/**
 * JoinModal — shown the first time a user opens the editor
 * so they can set their display name before joining.
 *
 * FIX: Replaces the old "Swift Otter" style dummy names.
 * The modal is skipped on revisits (name already in localStorage).
 */
import { useEffect, useRef, useState } from 'react';
import { User, Palette } from 'lucide-react';
import { PALETTE } from '../lib/identity';

interface JoinModalProps {
  onJoin: (name: string, color: string) => void;
  defaultColor: string;
  defaultName?: string;
}

export function JoinModal({ onJoin, defaultColor, defaultName = '' }: JoinModalProps) {
  const [name, setName]   = useState(defaultName);
  const [color, setColor] = useState(defaultColor);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Auto-focus the name field
    setTimeout(() => inputRef.current?.focus(), 60);
  }, []);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onJoin(trimmed, color);
  };

  return (
    <div className="join-overlay" role="dialog" aria-modal="true" aria-label="Join document">
      <div className="join-modal">
        <div className="join-header">
          <span className="join-icon"><User size={18} /></span>
          <h2 className="join-title">Who are you?</h2>
          <p className="join-sub">Your name will appear to other collaborators.</p>
        </div>

        <div className="join-body">
          <label className="join-label" htmlFor="join-name">Display name</label>
          <input
            ref={inputRef}
            id="join-name"
            className="join-input"
            placeholder="e.g. Rishav"
            value={name}
            maxLength={32}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            autoComplete="nickname"
            spellCheck={false}
          />

          <div className="join-color-row">
            <span className="join-label">
              <Palette size={12} style={{ marginRight: 5, opacity: 0.7 }} />
              Cursor color
            </span>
            <div className="join-palette">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  className={`join-swatch ${c === color ? 'join-swatch-active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={`Select color ${c}`}
                  title={c}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="join-footer">
          <button
            className="join-btn"
            onClick={handleSubmit}
            disabled={!name.trim()}
          >
            Join document →
          </button>
        </div>
      </div>
    </div>
  );
}
