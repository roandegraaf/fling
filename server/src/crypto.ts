import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
  createHash,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MASTER_KEY_ENV, MASTER_KEY_PATH } from './env.ts';

/**
 * On-disk blob format
 * ───────────────────
 *   blob = sealed(0) || sealed(1) || ... || sealed(n-1)
 *   sealed(i) = AES-256-GCM(plaintext chunk i) || 16-byte tag
 *
 * Every plaintext chunk is exactly CHUNK_SIZE bytes except the last, so the byte
 * offset of chunk i is always `i * (CHUNK_SIZE + TAG_LEN)`. That is what makes
 * HTTP Range requests O(1) on an encrypted file: seek straight to the chunk that
 * contains the requested offset and decrypt only that one.
 *
 * Each file gets its own key (HKDF from the master key, salted with the file id),
 * so a deterministic nonce derived from the chunk index can never repeat for a
 * given key — the one mistake in this scheme that would be catastrophic.
 */
export const CHUNK_SIZE = 4 * 1024 * 1024;
export const TAG_LEN = 16;
export const STRIDE = CHUNK_SIZE + TAG_LEN;

let masterKey: Buffer | null = null;

function parseKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const buf = Buffer.from(trimmed, 'base64');
  return buf.length === 32 ? buf : null;
}

/**
 * Resolves the master key: env var wins, otherwise a key file in the config dir,
 * otherwise generate one and persist it 0600. Losing this key loses every file.
 */
export function loadMasterKey(): Buffer {
  if (masterKey) return masterKey;

  if (MASTER_KEY_ENV) {
    const fromEnv = parseKey(MASTER_KEY_ENV);
    if (!fromEnv) {
      throw new Error(
        'FLING_MASTER_KEY is set but is not a valid 32-byte key (expected 64 hex chars or base64).',
      );
    }
    masterKey = fromEnv;
    return masterKey;
  }

  if (fs.existsSync(MASTER_KEY_PATH)) {
    const fromFile = parseKey(fs.readFileSync(MASTER_KEY_PATH, 'utf8'));
    if (!fromFile) throw new Error(`Master key file ${MASTER_KEY_PATH} is corrupt.`);
    masterKey = fromFile;
    return masterKey;
  }

  const generated = randomBytes(32);
  fs.mkdirSync(path.dirname(MASTER_KEY_PATH), { recursive: true });
  fs.writeFileSync(MASTER_KEY_PATH, generated.toString('base64') + '\n', { mode: 0o600 });
  masterKey = generated;
  return masterKey;
}

/** True when the key came from the environment rather than a generated file. */
export function masterKeySource(): 'env' | 'file' {
  return MASTER_KEY_ENV ? 'env' : 'file';
}

const fileKeyCache = new Map<string, Buffer>();

export function fileKey(fileId: string): Buffer {
  const cached = fileKeyCache.get(fileId);
  if (cached) return cached;
  const key = Buffer.from(
    hkdfSync('sha256', loadMasterKey(), Buffer.from(fileId, 'utf8'), Buffer.from('fling-file-v1'), 32),
  );
  // Bounded so a long-lived process with many transfers can't grow without limit.
  if (fileKeyCache.size > 512) fileKeyCache.clear();
  fileKeyCache.set(fileId, key);
  return key;
}

function nonceFor(chunkIndex: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(chunkIndex), 4);
  return nonce;
}

export function sealChunk(fileId: string, chunkIndex: number, plaintext: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', fileKey(fileId), nonceFor(chunkIndex));
  cipher.setAAD(Buffer.from(fileId, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

export function openChunk(fileId: string, chunkIndex: number, sealed: Buffer): Buffer {
  if (sealed.length < TAG_LEN) throw new Error(`chunk ${chunkIndex} is truncated`);
  const body = sealed.subarray(0, sealed.length - TAG_LEN);
  const tag = sealed.subarray(sealed.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', fileKey(fileId), nonceFor(chunkIndex));
  decipher.setAAD(Buffer.from(fileId, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/* ── passwords ───────────────────────────────────────────────────────────── */

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    const derived = scryptSync(password, salt, expected.length, SCRYPT);
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/* ── tokens ──────────────────────────────────────────────────────────────── */

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64');
}

/** Server-side signing key, derived from the master key so it survives restarts. */
function signingKey(): Buffer {
  return Buffer.from(
    hkdfSync('sha256', loadMasterKey(), Buffer.alloc(0), Buffer.from('fling-sign-v1'), 32),
  );
}

/** Signs `<payload>.<expiresAt>` so download grants need no server-side storage. */
export function signGrant(payload: string, ttlMs: number): string {
  const exp = Date.now() + ttlMs;
  const body = `${payload}.${exp}`;
  const sig = createHmac('sha256', signingKey()).update(body).digest('base64url');
  return `${exp}.${sig}`;
}

export function verifyGrant(payload: string, token: string | undefined | null): boolean {
  if (!token) return false;
  const idx = token.indexOf('.');
  if (idx <= 0) return false;
  const exp = Number(token.slice(0, idx));
  const sig = token.slice(idx + 1);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = createHmac('sha256', signingKey()).update(`${payload}.${exp}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A download session token: `<sessionId>~<signed grant>`. The id travels in the
 * clear so the server can find the row, and the signature binds it to this
 * transfer so a token cannot be moved to another one.
 */
export function signSession(slug: string, sessionId: string, ttlMs: number): string {
  return `${sessionId}~${signGrant(`acc:${slug}:${sessionId}`, ttlMs)}`;
}

export function verifySession(slug: string, token: string | null | undefined): string | null {
  if (!token) return null;
  const idx = token.indexOf('~');
  if (idx <= 0) return null;
  const sessionId = token.slice(0, idx);
  const signature = token.slice(idx + 1);
  return verifyGrant(`acc:${slug}:${sessionId}`, signature) ? sessionId : null;
}

/**
 * Stable per-(recipient, transfer) marker used to recognise someone coming back
 * to the same link. Keyed HMAC rather than the raw address, so re-opening a
 * link keeps working without the database accumulating recipients' IPs.
 */
export function clientFingerprint(ip: string | null | undefined, transferId: string): string {
  if (!ip) return '';
  return createHmac('sha256', signingKey()).update(`${transferId}|${ip}`).digest('base64');
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
