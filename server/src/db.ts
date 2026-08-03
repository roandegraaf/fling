import Database from 'better-sqlite3';
import fs from 'node:fs';
import { CONFIG_DIR, DB_PATH } from './env.ts';

export type TransferStatus = 'uploading' | 'complete';

export interface TransferRow {
  id: string;
  slug: string;
  created_at: number;
  expires_at: number;
  password_hash: string | null;
  download_limit: number | null;
  download_count: number;
  status: TransferStatus;
  upload_token_hash: string;
  total_size: number;
  file_count: number;
  sender_ip: string | null;
  completed_at: number | null;
  last_download_at: number | null;
}

/** How the blob is encoded. NULL means the sender's bytes, verbatim. */
export type FileCodec = null | 'jxl';

export type ShrinkState = 'pending' | 'shrunk' | 'done' | 'skipped';

export interface FileRow {
  id: string;
  transfer_id: string;
  path: string;
  /** Length of the *original* file — what a recipient downloads. Never changes. */
  size: number;
  chunk_size: number;
  chunk_count: number;
  received_bitmap: Buffer;
  received_count: number;
  complete: number;
  sort_order: number;
  codec: FileCodec;
  /** Bytes the blob actually holds. NULL means "same as size". */
  stored_size: number | null;
  shrink_state: ShrinkState;
}

/** Bytes this file occupies on disk, before per-chunk tags. */
export function storedSizeOf(file: FileRow): number {
  return file.stored_size ?? file.size;
}

export interface DirRow {
  transfer_id: string;
  path: string;
}

export interface DownloadSessionRow {
  id: string;
  transfer_id: string;
  fingerprint: string;
  created_at: number;
  last_seen_at: number;
  counted: number;
}

fs.mkdirSync(CONFIG_DIR, { recursive: true });

export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE transfers (
    id                TEXT PRIMARY KEY,
    slug              TEXT NOT NULL UNIQUE,
    created_at        INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    password_hash     TEXT,
    download_limit    INTEGER,
    download_count    INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'uploading',
    upload_token_hash TEXT NOT NULL,
    total_size        INTEGER NOT NULL DEFAULT 0,
    file_count        INTEGER NOT NULL DEFAULT 0,
    sender_ip         TEXT,
    completed_at      INTEGER,
    last_download_at  INTEGER
  );
  CREATE INDEX idx_transfers_expires ON transfers(expires_at);
  CREATE INDEX idx_transfers_created ON transfers(created_at DESC);

  CREATE TABLE files (
    id              TEXT PRIMARY KEY,
    transfer_id     TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
    path            TEXT NOT NULL,
    size            INTEGER NOT NULL,
    chunk_size      INTEGER NOT NULL,
    chunk_count     INTEGER NOT NULL,
    received_bitmap BLOB NOT NULL,
    received_count  INTEGER NOT NULL DEFAULT 0,
    complete        INTEGER NOT NULL DEFAULT 0,
    sort_order      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_files_transfer ON files(transfer_id);

  CREATE TABLE dirs (
    transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    PRIMARY KEY (transfer_id, path)
  );

  CREATE TABLE admin_sessions (
    id         TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,

  // v2 — recipient download sessions, so the limit can count people rather than
  // files, and a returning visitor is recognised instead of charged again.
  `
  CREATE TABLE download_sessions (
    id           TEXT PRIMARY KEY,
    transfer_id  TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
    fingerprint  TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    counted      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_dl_sessions_lookup ON download_sessions(transfer_id, fingerprint, last_seen_at DESC);
  CREATE INDEX idx_dl_sessions_seen   ON download_sessions(last_seen_at);
  `,

  // v3 — losslessly recompressed storage. `codec` names how the blob is encoded
  // (NULL = the original bytes, verbatim); `stored_size` is how many bytes the
  // blob actually holds, which stops matching `size` once a codec is applied.
  // `shrink_state` drives the background pass:
  //   pending → shrunk → done   (or → skipped, terminally)
  // 'shrunk' means the new blob is live but the superseded original is still on
  // disk on purpose — see cleanup.ts for why it is not deleted immediately.
  `
  ALTER TABLE files ADD COLUMN codec        TEXT;
  ALTER TABLE files ADD COLUMN stored_size  INTEGER;
  ALTER TABLE files ADD COLUMN shrink_state TEXT NOT NULL DEFAULT 'pending';
  CREATE INDEX idx_files_shrink ON files(shrink_state);
  `,
];

function migrate(): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version];
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

migrate();

/* ── chunk bitmap ────────────────────────────────────────────────────────── */

export function newBitmap(chunkCount: number): Buffer {
  return Buffer.alloc(Math.ceil(chunkCount / 8));
}

export function hasBit(bitmap: Buffer, index: number): boolean {
  const byte = index >> 3;
  if (byte >= bitmap.length) return false;
  return (bitmap[byte] & (1 << (index & 7))) !== 0;
}

export function setBit(bitmap: Buffer, index: number): boolean {
  const byte = index >> 3;
  if (byte >= bitmap.length) return false;
  const mask = 1 << (index & 7);
  if ((bitmap[byte] & mask) !== 0) return false; // already had it
  bitmap[byte] |= mask;
  return true;
}

export function missingChunks(bitmap: Buffer, chunkCount: number, limit = Infinity): number[] {
  const out: number[] = [];
  for (let i = 0; i < chunkCount && out.length < limit; i++) {
    if (!hasBit(bitmap, i)) out.push(i);
  }
  return out;
}

/* ── prepared statements ─────────────────────────────────────────────────── */

export const q = {
  transferById: db.prepare<[string], TransferRow>('SELECT * FROM transfers WHERE id = ?'),
  transferBySlug: db.prepare<[string], TransferRow>('SELECT * FROM transfers WHERE slug = ?'),
  filesOfTransfer: db.prepare<[string], FileRow>(
    'SELECT * FROM files WHERE transfer_id = ? ORDER BY sort_order, path',
  ),
  fileById: db.prepare<[string], FileRow>('SELECT * FROM files WHERE id = ?'),
  dirsOfTransfer: db.prepare<[string], DirRow>('SELECT * FROM dirs WHERE transfer_id = ? ORDER BY path'),

  insertTransfer: db.prepare(`
    INSERT INTO transfers (id, slug, created_at, expires_at, password_hash, download_limit,
                           status, upload_token_hash, total_size, file_count, sender_ip)
    VALUES (@id, @slug, @created_at, @expires_at, @password_hash, @download_limit,
            'uploading', @upload_token_hash, @total_size, @file_count, @sender_ip)
  `),
  insertFile: db.prepare(`
    INSERT INTO files (id, transfer_id, path, size, chunk_size, chunk_count,
                       received_bitmap, received_count, complete, sort_order)
    VALUES (@id, @transfer_id, @path, @size, @chunk_size, @chunk_count,
            @received_bitmap, 0, @complete, @sort_order)
  `),
  insertDir: db.prepare('INSERT OR IGNORE INTO dirs (transfer_id, path) VALUES (?, ?)'),

  updateFileProgress: db.prepare(
    'UPDATE files SET received_bitmap = ?, received_count = ?, complete = ? WHERE id = ?',
  ),
  markTransferComplete: db.prepare(
    "UPDATE transfers SET status = 'complete', completed_at = ? WHERE id = ?",
  ),
  bumpDownloadCount: db.prepare(
    'UPDATE transfers SET download_count = download_count + 1, last_download_at = ? WHERE id = ?',
  ),
  deleteTransfer: db.prepare('DELETE FROM transfers WHERE id = ?'),

  expiredTransfers: db.prepare<[number], TransferRow>('SELECT * FROM transfers WHERE expires_at <= ?'),
  stalledUploads: db.prepare<[number], TransferRow>(
    "SELECT * FROM transfers WHERE status = 'uploading' AND created_at <= ?",
  ),
  allTransfers: db.prepare<[], TransferRow>('SELECT * FROM transfers ORDER BY created_at DESC'),
  totalStoredBytes: db.prepare<[], { total: number }>(
    "SELECT COALESCE(SUM(size), 0) AS total FROM files",
  ),

  /* ── lossless recompression ────────────────────────────────────────────── */

  /** Oldest complete files still awaiting a shrink attempt. */
  shrinkCandidates: db.prepare<[number], FileRow>(`
    SELECT f.* FROM files f
    JOIN transfers t ON t.id = f.transfer_id
    WHERE f.shrink_state = 'pending' AND f.complete = 1 AND t.status = 'complete'
    ORDER BY f.rowid
    LIMIT ?
  `),
  markShrunk: db.prepare(
    "UPDATE files SET codec = ?, stored_size = ?, shrink_state = 'shrunk' WHERE id = ?",
  ),
  markSwept: db.prepare("UPDATE files SET shrink_state = 'done' WHERE id = ?"),
  markShrinkSkipped: db.prepare("UPDATE files SET shrink_state = 'skipped' WHERE id = ?"),
  /** Logical bytes vs bytes actually stored — the two diverge once a codec applies. */
  shrinkTotals: db.prepare<[], { logical: number; stored: number; shrunk: number }>(`
    SELECT COALESCE(SUM(size), 0)                        AS logical,
           COALESCE(SUM(COALESCE(stored_size, size)), 0) AS stored,
           COALESCE(SUM(codec IS NOT NULL), 0)           AS shrunk
    FROM files WHERE complete = 1
  `),
  /**
   * Recompressed files whose superseded original is still on disk. Bounded by
   * the state flag rather than scanning every shrunk file on every sweep.
   */
  unsweptFiles: db.prepare<[number], FileRow>(
    "SELECT * FROM files WHERE shrink_state = 'shrunk' LIMIT ?",
  ),
  pendingShrinkCount: db.prepare<[], { n: number }>(
    "SELECT COUNT(*) AS n FROM files WHERE shrink_state = 'pending' AND complete = 1",
  ),

  getSetting: db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?'),
  allSettings: db.prepare<[], { key: string; value: string }>('SELECT key, value FROM settings'),
  putSetting: db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ),

  insertDownloadSession: db.prepare(`
    INSERT INTO download_sessions (id, transfer_id, fingerprint, created_at, last_seen_at, counted)
    VALUES (?, ?, ?, ?, ?, 0)
  `),
  downloadSession: db.prepare<[string], DownloadSessionRow>(
    'SELECT * FROM download_sessions WHERE id = ?',
  ),
  /** Most recent still-warm session for this visitor, used to recognise a return. */
  reusableDownloadSession: db.prepare<[string, string, number], DownloadSessionRow>(`
    SELECT * FROM download_sessions
    WHERE transfer_id = ? AND fingerprint = ? AND fingerprint <> '' AND last_seen_at >= ?
    ORDER BY last_seen_at DESC LIMIT 1
  `),
  touchDownloadSession: db.prepare(
    'UPDATE download_sessions SET last_seen_at = ? WHERE id = ?',
  ),
  markDownloadSessionCounted: db.prepare(
    'UPDATE download_sessions SET counted = 1, last_seen_at = ? WHERE id = ?',
  ),
  purgeDownloadSessions: db.prepare('DELETE FROM download_sessions WHERE last_seen_at <= ?'),

  insertAdminSession: db.prepare(
    'INSERT INTO admin_sessions (id, created_at, expires_at) VALUES (?, ?, ?)',
  ),
  adminSession: db.prepare<[string], { id: string; expires_at: number }>(
    'SELECT id, expires_at FROM admin_sessions WHERE id = ?',
  ),
  deleteAdminSession: db.prepare('DELETE FROM admin_sessions WHERE id = ?'),
  purgeAdminSessions: db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?'),
};

export function closeDb(): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch {
    /* already closed */
  }
}

export const dbFileSize = (): number => {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += fs.statSync(DB_PATH + suffix).size;
    } catch {
      /* missing is fine */
    }
  }
  return total;
};
