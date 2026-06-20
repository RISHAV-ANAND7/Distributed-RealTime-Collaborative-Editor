/**
 * User identity helpers.
 *
 * Key design decisions:
 *
 * 1. SITE-ID STABILITY
 *    siteId is stored in sessionStorage so it survives React re-renders and
 *    HMR reloads within a single tab, but a fresh tab gets a new siteId.
 *    This prevents the same user from appearing as multiple ghosts when the
 *    component re-mounts.
 *
 * 2. REAL DISPLAY NAME
 *    getEffectiveDisplayName(username?) returns the authenticated user's
 *    username when available, falling back to the manually-set name from
 *    localStorage, and finally 'Anonymous'. This means logged-in users
 *    always appear with their real account name — no random animal names.
 *
 * 3. COLOUR PERSISTENCE
 *    getUserColor auto-assigns from PALETTE and persists to localStorage so
 *    the same user keeps the same colour across sessions.
 */

const NAME_KEY    = 'crdt.user.name';
const COLOR_KEY   = 'crdt.user.color';
const SITE_ID_KEY = 'crdt.tab.siteId'; // sessionStorage — one per browser tab

export const PALETTE = [
  '#6366f1', '#06b6d4', '#f97316', '#10b981',
  '#f43f5e', '#a855f7', '#eab308', '#ec4899',
  '#0ea5e9', '#84cc16', '#14b8a6', '#8b5cf6',
];

// ---------------------------------------------------------------------------
// Site ID  (tab-stable)
// ---------------------------------------------------------------------------

/**
 * Returns a siteId that is stable for the lifetime of this browser tab.
 * Calling this multiple times from the same tab always returns the same id.
 */
export function getOrCreateTabSiteId(): string {
  try {
    const stored = sessionStorage.getItem(SITE_ID_KEY);
    if (stored) return stored;
    const fresh = _makeUuid();
    sessionStorage.setItem(SITE_ID_KEY, fresh);
    return fresh;
  } catch {
    // sessionStorage blocked — fall back to a module-level singleton
    return _moduleId;
  }
}

const _moduleId = _makeUuid(); // one per module load (tab)

function _makeUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    }
  } catch {}
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
}

// ---------------------------------------------------------------------------
// Display name
// ---------------------------------------------------------------------------

/** Returns the manually-set name from localStorage, or null. */
export function getStoredName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

/**
 * Returns the best available display name:
 *   1. authenticated username (from JWT / auth context)
 *   2. manually-set name stored in localStorage
 *   3. 'Anonymous'
 */
export function getEffectiveDisplayName(authUsername?: string | null): string {
  if (authUsername) return authUsername;
  return getStoredName() ?? 'Anonymous';
}

/** @deprecated Use getEffectiveDisplayName(). */
export function getUserName(): string {
  return getStoredName() ?? 'Anonymous';
}

export function setUserName(name: string): void {
  try { localStorage.setItem(NAME_KEY, name); } catch {}
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export function getUserColor(): string {
  try {
    const stored = localStorage.getItem(COLOR_KEY);
    if (stored) return stored;
  } catch {}
  const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  try { localStorage.setItem(COLOR_KEY, color); } catch {}
  return color;
}

export function setUserColor(color: string): void {
  try { localStorage.setItem(COLOR_KEY, color); } catch {}
}

/** @deprecated Use getOrCreateTabSiteId(). */
export function newSiteId(): string {
  return getOrCreateTabSiteId();
}
