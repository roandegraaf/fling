import path from 'node:path';

function dir(envValue: string | undefined, fallback: string): string {
  return path.resolve(envValue && envValue.trim() ? envValue.trim() : fallback);
}

/** SQLite + master key live here. On Unraid: a cache-backed appdata share. */
export const CONFIG_DIR = dir(process.env.FLING_CONFIG_DIR, './.data/config');

/** Encrypted blobs live here. On Unraid: the array share you want the files on. */
export const DATA_DIR = dir(process.env.FLING_DATA_DIR, './.data/files');

export const BLOB_DIR = path.join(DATA_DIR, 'blobs');
export const DB_PATH = path.join(CONFIG_DIR, 'fling.db');
export const MASTER_KEY_PATH = path.join(CONFIG_DIR, 'master.key');

export const PORT = Number(process.env.PORT ?? process.env.FLING_PORT ?? 8080);
export const HOST = process.env.FLING_HOST ?? '0.0.0.0';

/** Trust X-Forwarded-* — turn on when behind Nginx Proxy Manager / SWAG / Traefik. */
export const TRUST_PROXY = ['1', 'true', 'yes'].includes(
  String(process.env.FLING_TRUST_PROXY ?? 'true').toLowerCase(),
);

/**
 * Public base URL used when building share links, e.g. https://fling.example.com
 * Leave empty to derive it from the incoming request (works fine behind a proxy
 * that sets X-Forwarded-Host / X-Forwarded-Proto).
 */
export const PUBLIC_URL = (process.env.FLING_PUBLIC_URL ?? '').replace(/\/+$/, '');

/** Sets/overwrites the admin password on every boot when present. */
export const ADMIN_PASSWORD_ENV = process.env.FLING_ADMIN_PASSWORD ?? '';

/** 32-byte key as base64 or hex. When absent one is generated into CONFIG_DIR. */
export const MASTER_KEY_ENV = process.env.FLING_MASTER_KEY ?? '';


/** Where the built SPA lives (production only). */
export const WEB_DIST = path.resolve(
  process.env.FLING_WEB_DIST ?? path.join(import.meta.dirname, '../../web/dist'),
);
