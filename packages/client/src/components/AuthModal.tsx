/**
 * AuthModal.tsx — login / register modal
 *
 * Displayed when the user tries to create a document or access a route
 * that requires authentication. Tabs between Login and Register.
 */

import { useState, type FormEvent } from 'react';
import { useAuth } from '../hooks/useAuth';

interface AuthModalProps {
  onClose?: () => void;
  /** If provided, shown as a context message (e.g. "Sign in to create documents") */
  message?: string;
}

export function AuthModal({ onClose, message }: AuthModalProps) {
  const { login, register, loading } = useAuth();
  const [tab, setTab]           = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      if (tab === 'login') {
        await login(username, password);
      } else {
        await register(username, password);
      }
      onClose?.();
    } catch (err: any) {
      setError(err.message ?? 'Something went wrong');
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal-card auth-modal">
        <div className="auth-tabs">
          <button
            className={`auth-tab ${tab === 'login' ? 'auth-tab-active' : ''}`}
            onClick={() => { setTab('login'); setError(''); }}
          >
            Sign in
          </button>
          <button
            className={`auth-tab ${tab === 'register' ? 'auth-tab-active' : ''}`}
            onClick={() => { setTab('register'); setError(''); }}
          >
            Register
          </button>
        </div>

        {message && <p className="auth-message">{message}</p>}

        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-label">
            Username
            <input
              className="auth-input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. rishav"
              autoFocus
              autoComplete="username"
              minLength={3}
              maxLength={32}
              required
            />
          </label>
          <label className="auth-label">
            Password
            <input
              className="auth-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={tab === 'register' ? 'At least 8 characters' : ''}
              autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
              minLength={tab === 'register' ? 8 : 1}
              required
            />
          </label>

          {error && <p className="auth-error">{error}</p>}

          <button className="auth-submit" type="submit" disabled={loading}>
            {loading ? 'Please wait…' : tab === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}
