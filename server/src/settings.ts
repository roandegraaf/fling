import { db, q } from './db.ts';

/** Hard ceiling on expiry that the admin page cannot raise. */
export const EXPIRY_DAYS_CEILING = 30;

export interface Settings {
  /** Largest total size of one transfer, in bytes. */
  maxTransferSize: number;
  /** Largest single file, in bytes. */
  maxFileSize: number;
  /** Most files allowed in one transfer. */
  maxFileCount: number;
  /** Longest expiry a sender may pick, in days (never above EXPIRY_DAYS_CEILING). */
  maxExpiryDays: number;
  /** Pre-selected expiry in the compose form. */
  defaultExpiryDays: number;
  /** Stop accepting uploads once stored bytes exceed this. 0 = unlimited. */
  storageQuotaBytes: number;
  /** Abandoned half-finished uploads are swept after this many hours. */
  incompleteUploadTtlHours: number;
  /** How often the cleanup job runs, in minutes. */
  cleanupIntervalMinutes: number;
  /**
   * Losslessly recompress stored files in the background. Recipients always get
   * the original bytes back; this only changes how they are held on disk.
   */
  shrinkEnabled: boolean;
  /** Scrypt hash; empty means the admin password has not been set up yet. */
  adminPasswordHash: string;
}

const DEFAULTS: Settings = {
  maxTransferSize: 20 * 1024 ** 3, // 20 GiB
  maxFileSize: 20 * 1024 ** 3,
  maxFileCount: 5000,
  maxExpiryDays: EXPIRY_DAYS_CEILING,
  defaultExpiryDays: 7,
  storageQuotaBytes: 0,
  incompleteUploadTtlHours: 48,
  cleanupIntervalMinutes: 15,
  shrinkEnabled: true,
  adminPasswordHash: '',
};

const NUMERIC_BOUNDS: Record<string, { min: number; max: number }> = {
  maxTransferSize: { min: 1024 ** 2, max: 2 * 1024 ** 4 }, // 1 MiB … 2 TiB
  maxFileSize: { min: 1024 ** 2, max: 2 * 1024 ** 4 },
  maxFileCount: { min: 1, max: 100_000 },
  maxExpiryDays: { min: 1, max: EXPIRY_DAYS_CEILING },
  defaultExpiryDays: { min: 1, max: EXPIRY_DAYS_CEILING },
  storageQuotaBytes: { min: 0, max: Number.MAX_SAFE_INTEGER },
  incompleteUploadTtlHours: { min: 1, max: 24 * 30 },
  cleanupIntervalMinutes: { min: 1, max: 24 * 60 },
};

let cache: Settings | null = null;

function readAll(): Settings {
  const stored = new Map(q.allSettings.all().map((r) => [r.key, r.value]));
  const out = { ...DEFAULTS };

  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const raw = stored.get(key);
    if (raw === undefined) continue;
    if (key === 'adminPasswordHash') {
      out.adminPasswordHash = raw;
      continue;
    }
    if (key === 'shrinkEnabled') {
      out.shrinkEnabled = raw === 'true' || raw === '1';
      continue;
    }
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) (out[key] as number) = parsed;
  }

  // A stale DB value must never let expiry exceed the ceiling.
  out.maxExpiryDays = Math.min(out.maxExpiryDays, EXPIRY_DAYS_CEILING);
  out.defaultExpiryDays = Math.min(out.defaultExpiryDays, out.maxExpiryDays);
  return out;
}

export function getSettings(): Settings {
  if (!cache) cache = readAll();
  return cache;
}

/** All-or-nothing, so a rejected value can never leave a half-applied patch. */
const writeSettings = db.transaction((patch: Partial<Settings>) => {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) continue;
    if (key === 'adminPasswordHash') {
      q.putSetting.run(key, String(value));
      continue;
    }
    if (key === 'shrinkEnabled') {
      q.putSetting.run(key, value ? 'true' : 'false');
      continue;
    }
    const num = Number(value);
    if (!Number.isFinite(num)) continue;
    const bounds = NUMERIC_BOUNDS[key];
    const clamped = Math.min(Math.max(Math.floor(num), bounds.min), bounds.max);
    q.putSetting.run(key, String(clamped));
  }
});

export function updateSettings(patch: Partial<Settings>): Settings {
  writeSettings(patch);
  cache = null;
  return getSettings();
}

export function setAdminPasswordHash(hash: string): void {
  q.putSetting.run('adminPasswordHash', hash);
  cache = null;
}

/** The subset that is safe to hand to an unauthenticated browser. */
export function publicSettings() {
  const s = getSettings();
  return {
    maxTransferSize: s.maxTransferSize,
    maxFileSize: s.maxFileSize,
    maxFileCount: s.maxFileCount,
    maxExpiryDays: s.maxExpiryDays,
    defaultExpiryDays: s.defaultExpiryDays,
  };
}

