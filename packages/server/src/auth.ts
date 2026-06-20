

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


export type AuthRequest = Request;


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

export const optionalAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7);
    const payload = verifyToken(token);
    if (payload) req.user = payload;
  }
  next();
};


const WS_TICKET_TTL_MS = 30_000;

interface TicketEntry {
  payload: JwtPayload;
  expiresAt: number;
}

const wsTickets = new Map<string, TicketEntry>();

function pruneTickets(): void {
  const now = Date.now();
  for (const [k, v] of wsTickets) {
    if (v.expiresAt < now) wsTickets.delete(k);
  }
}

export function createWsTicket(payload: JwtPayload): string {
  pruneTickets();
  const ticket = randomBytes(16).toString('hex');
  wsTickets.set(ticket, { payload, expiresAt: Date.now() + WS_TICKET_TTL_MS });
  return ticket;
}

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
