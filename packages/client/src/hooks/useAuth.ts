/**
 * useAuth.ts — global auth state (JWT token + user profile)
 *
 * Stores token in localStorage. Exposes login(), register(), logout().
 * Used by <AuthContext> wrapped at the app root.
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { API_URL } from '../lib/config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  username: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  loading: boolean;
}

interface AuthActions {
  login(username: string, password: string): Promise<void>;
  register(username: string, password: string): Promise<void>;
  logout(): void;
}

export type AuthContextType = AuthState & AuthActions;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider (created as a plain function that returns JSX)
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'crdt.auth.token';
const USER_KEY  = 'crdt.auth.user';

function readStored(): { token: string | null; user: User | null } {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const raw   = localStorage.getItem(USER_KEY);
    const user  = raw ? (JSON.parse(raw) as User) : null;
    return { token, user };
  } catch {
    return { token: null, user: null };
  }
}

export function createAuthState(): AuthContextType {
  const stored = readStored();
  const [state, setState] = useState<AuthState>({
    user: stored.user,
    token: stored.token,
    loading: false,
  });

  const persist = useCallback((token: string, user: User) => {
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch {}
    setState({ user, token, loading: false });
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    setState((s) => ({ ...s, loading: true }));
    const res = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Login failed');
    persist(data.token, data.user);
  }, [persist]);

  const register = useCallback(async (username: string, password: string) => {
    setState((s) => ({ ...s, loading: true }));
    const res = await fetch(`${API_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Registration failed');
    persist(data.token, data.user);
  }, [persist]);

  const logout = useCallback(() => {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch {}
    setState({ user: null, token: null, loading: false });
  }, []);

  return { ...state, login, register, logout };
}
