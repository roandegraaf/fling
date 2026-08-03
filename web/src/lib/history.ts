/**
 * "Your transfers" is deliberately device-local: there are no accounts, so the
 * only place a sender's list can live is their own browser. The admin page is the
 * server-side view for everything.
 */

const HISTORY_KEY = 'fling.history.v1';
const PENDING_KEY = 'fling.pending.v1';
const MAX_ENTRIES = 200;

export interface HistoryEntry {
  transferId: string;
  uploadToken: string;
  slug: string;
  url: string;
  createdAt: number;
  expiresAt: number;
  totalSize: number;
  fileCount: number;
  /** e.g. "Campaign_master_v4.mov" — the first file, for a recognisable label. */
  firstName: string;
  hasPassword: boolean;
  downloadLimit: number | null;
}

/** An upload that was interrupted, so it can be offered for resume after a reload. */
export interface PendingTransfer {
  transferId: string;
  uploadToken: string;
  slug: string;
  url: string;
  createdAt: number;
  expiresAt: number;
  files: Array<{ id: string; path: string; size: number; chunkSize: number; chunkCount: number }>;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    // Private mode, disabled storage, or corrupt JSON — history is a nicety.
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export function listHistory(): HistoryEntry[] {
  const entries = read<HistoryEntry[]>(HISTORY_KEY, []);
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => e && typeof e.transferId === 'string' && typeof e.slug === 'string')
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function addHistory(entry: HistoryEntry): void {
  const existing = listHistory().filter((e) => e.transferId !== entry.transferId);
  write(HISTORY_KEY, [entry, ...existing].slice(0, MAX_ENTRIES));
}

export function removeHistory(transferId: string): void {
  write(
    HISTORY_KEY,
    listHistory().filter((e) => e.transferId !== transferId),
  );
}

export function clearHistory(): void {
  write(HISTORY_KEY, []);
}

export function getPending(): PendingTransfer | null {
  const pending = read<PendingTransfer | null>(PENDING_KEY, null);
  if (!pending || !pending.transferId || !Array.isArray(pending.files)) return null;
  // An expired half-upload is not worth offering to resume.
  if (pending.expiresAt && pending.expiresAt <= Date.now()) {
    clearPending();
    return null;
  }
  return pending;
}

export function setPending(pending: PendingTransfer): void {
  write(PENDING_KEY, pending);
}

export function clearPending(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}
