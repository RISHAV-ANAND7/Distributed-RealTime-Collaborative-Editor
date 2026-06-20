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
import type { Request, Response, NextFunction } from 'express';
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

export interface AuthRequest extends Request {
  user?: JwtPayload;
}

/**
 * requireAuth — 401 if no valid JWT present.
 * Token is read from Authorization: Bearer <token> header.
 */
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
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
}

/**
 * optionalAuth — sets req.user if a valid token is present; never 401s.
 * Used for endpoints that behave differently for authenticated vs anonymous users.
 */
export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7);
    const payload = verifyToken(token);
    if (payload) req.user = payload;
  }
  next();
}

/**
 * extractWsToken — parses a JWT from a WebSocket upgrade request.
 * Clients send the token as a query param: /ws/docId?token=...
 */
export function extractWsToken(url: string): JwtPayload | null {
  try {
    const parsed = new URL(url, 'http://localhost');
    const token = parsed.searchParams.get('token');
    if (!token) return null;
    return verifyToken(token);
  } catch {
    return null;
  }
}
