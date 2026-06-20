

const NAME_KEY = 'crdt.user.name';
const COLOR_KEY = 'crdt.user.color';
const SITE_ID_KEY = 'crdt.tab.siteId';

export const PALETTE = [
  '#6366f1', '#06b6d4', '#f97316', '#10b981',
  '#f43f5e', '#a855f7', '#eab308', '#ec4899',
  '#0ea5e9', '#84cc16', '#14b8a6', '#8b5cf6',
];


export function getOrCreateTabSiteId(): string {
  try {
    const stored = sessionStorage.getItem(SITE_ID_KEY);
    if (stored) return stored;
    const fresh = _makeUuid();
    sessionStorage.setItem(SITE_ID_KEY, fresh);
    return fresh;
  } catch {
    return _moduleId;
  }
}

const _moduleId = _makeUuid();

function _makeUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    }
  } catch { }
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
}


export function getStoredName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}


export function getEffectiveDisplayName(authUsername?: string | null): string {
  if (authUsername) return authUsername;
  return getStoredName() ?? 'Anonymous';
}


export function getUserName(): string {
  return getStoredName() ?? 'Anonymous';
}

export function setUserName(name: string): void {
  try { localStorage.setItem(NAME_KEY, name); } catch { }
}



export function getUserColor(): string {
  try {
    const stored = localStorage.getItem(COLOR_KEY);
    if (stored) return stored;
  } catch { }
  const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  try { localStorage.setItem(COLOR_KEY, color); } catch { }
  return color;
}

export function setUserColor(color: string): void {
  try { localStorage.setItem(COLOR_KEY, color); } catch { }
}


export function newSiteId(): string {
  return getOrCreateTabSiteId();
}
