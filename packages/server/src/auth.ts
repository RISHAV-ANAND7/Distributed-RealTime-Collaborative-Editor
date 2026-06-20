/**
 * auth.ts — JWT-based authentication middleware
 *
 * Tokens are HS256 JWTs signed with JWT_SECRET (env var, required in production).
 * Each token payload: { sub: userId, username: string, iat, exp }
 *
 * Access tokens expire in 24 hours. No refresh tokens — keep it simple.
 *
 * PBKDF2 (100 000 iterations, SHA-256, 32-byte key) is used for password
 * hashing. This is intentionally slow to resist offline brute-force.
 */

import { createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';

const pbkdf2Async = promisify(pbkdf2);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
const JWT_EXPIRY = '24h';

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('[auth] FATAL: JWT_SECRET env var not set in production. Exiting.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && process.env.JWT_SECRET &&
    process.env.JWT_SECRET.length < 32) {
  console.error('[auth] FATAL: JWT_SECRET must be at least 32 characters in production.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = await pbkdf2Async(password, salt, 100_000, 32, 'sha256');
  return `${salt}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hex] = stored.split(':');
  if (!salt || !hex) return false;
  const hash = await pbkdf2Async(password, salt, 100_000, 32, 'sha256');
  const expected = Buffer.from(hex, 'hex');
  // Use timing-safe comparison to prevent timing attacks.
  return expected.length === hash.length && timingSafeEqual(expected, hash);
}

// ---------------------------------------------------------------------------
// JWT tokens
// ---------------------------------------------------------------------------

export interface JwtPayload {
  sub: string;      // userId
  username: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload & jwt.JwtPayload;
    return { sub: decoded.sub, username: decoded.username };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

/**
 * AuthRequest is kept for backwards compatibility with callers that
 * explicitly type req as AuthRequest. With the Express namespace augmentation
 * in `types/express.d.ts`, the plain `Request` type already carries `user`.
 */
export type AuthRequest = Request;

/**
 * requireAuth — 401 if no valid JWT present.
 * Token is read from Authorization: Bearer <token> header.
 */
export const requireAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }
  const token = header.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  req.user = payload;
  next();
};

/**
 * optionalAuth — sets req.user if a valid token is present; never 401s.
 * Used for endpoints that behave differently for authenticated vs anonymous users.
 */
export const optionalAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7);
    const payload = verifyToken(token);
    if (payload) req.user = payload;
  }
  next();
};

/**
 * WebSocket one-time ticket system.
 *
 * Problem: browsers cannot send custom headers on WebSocket upgrades.
 * The previous solution passed the JWT as a ?token= query param, which
 * caused the token to appear in server/proxy access logs and browser history.
 *
 * Solution: clients POST to /auth/ws-ticket to get a short-lived (30 s)
 * opaque ticket UUID. They then pass ?ticket= (not ?token=) in the WS URL.
 * The server consumes (deletes) the ticket on the first WS upgrade, so each
 * ticket is valid exactly once. Expired or unknown tickets are rejected.
 */

/** TTL for one-time WS tickets (ms). */
const WS_TICKET_TTL_MS = 30_000;

interface TicketEntry {
  payload: JwtPayload;
  expiresAt: number;
}

const wsTickets = new Map<string, TicketEntry>();

/** Remove expired tickets lazily to bound map growth. */
function pruneTickets(): void {
  const now = Date.now();
  for (const [k, v] of wsTickets) {
    if (v.expiresAt < now) wsTickets.delete(k);
  }
}

/**
 * Issue a one-time ticket for an authenticated user.
 * Returns the ticket string (UUID) to be passed as ?ticket= in the WS URL.
 */
export function createWsTicket(payload: JwtPayload): string {
  pruneTickets();
  const ticket = randomBytes(16).toString('hex');
  wsTickets.set(ticket, { payload, expiresAt: Date.now() + WS_TICKET_TTL_MS });
  return ticket;
}

/**
 * extractWsToken — resolves the identity for a WebSocket upgrade request.
 *
 * Priority:
 *   1. ?ticket= — one-time ticket (preferred; avoids JWT in URL/logs).
 *   2. ?token=  — raw JWT (legacy fallback; still accepted so existing
 *                 clients / integrations continue working).
 */
export function extractWsToken(url: string): JwtPayload | null {
  try {
    const parsed = new URL(url, 'http://localhost');

    // Preferred: consume a one-time ticket.
    const ticket = parsed.searchParams.get('ticket');
    if (ticket) {
      const entry = wsTickets.get(ticket);
      wsTickets.delete(ticket); // consume immediately — single-use
      if (!entry || entry.expiresAt < Date.now()) return null;
      return entry.payload;
    }

    // Legacy fallback: raw JWT in query string.
    const token = parsed.searchParams.get('token');
    if (!token) return null;
    return verifyToken(token);
  } catch {
    return null;
  }
}
