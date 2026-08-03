import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { q, storedSizeOf, type FileCodec, type FileRow } from './db.ts';
import { getSettings } from './settings.ts';
import { blobPath, readStored, removeBlob, writeWholeBlob } from './storage.ts';

const run = promisify(execFile);

/**
 * Lossless recompression
 * ──────────────────────
 * A JPEG is not at the entropy floor of its pixels — it is at the floor of its
 * own 1992 Huffman coder. JPEG XL can re-encode that bitstream with a modern
 * entropy coder and reconstruct the *original file* bit-for-bit, which typically
 * takes 15-20% off. General-purpose compressors get ~0% on the same bytes.
 *
 * The safety rule this module is built around: **the original is never discarded
 * until the round trip has been proved on the actual bytes.** Encode, decode,
 * compare SHA-256 against the input, and only then point the database at the
 * smaller blob. Anything unexpected — a missing encoder, a codec quirk, a file
 * that grows — leaves the file exactly as it was.
 */

export const JPEG_EXTENSIONS = new Set(['jpg', 'jpeg']);

const BOUNDS = {
  /** Below this, the codec overhead and the CPU are not worth it. */
  min: 32 * 1024,
  /**
   * Above this we decline. Decoding is whole-file, so this bounds the memory a
   * single download can cost, and it keeps the range-seek path (which
   * recompressed files lose) restricted to files small enough that seeking
   * never mattered.
   */
  max: 48 * 1024 * 1024,
  /** Must beat this, or it is not worth the decode cost on every future download. */
  minSaving: 0.03,
  /**
   * How long a superseded original stays on disk after its replacement goes
   * live. It only has to outlast the longest gap between a request reading a
   * `FileRow` and actually opening the blob — which for a large zip is however
   * long the archive takes to reach that entry.
   */
  sweepGraceMs: 60 * 60 * 1000,
};

/** Test seam — the suite works with fixtures far below the production floor. */
export function __setBounds(patch: Partial<typeof BOUNDS>): void {
  Object.assign(BOUNDS, patch);
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

const extensionOf = (p: string): string => {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
};

/* ── encoder availability ────────────────────────────────────────────────── */

let toolsAvailable: boolean | null = null;

/** Cached because it is checked on every worker pass and cannot change at runtime. */
export async function encoderAvailable(): Promise<boolean> {
  if (toolsAvailable !== null) return toolsAvailable;
  try {
    await Promise.all([run('cjxl', ['--version']), run('djxl', ['--version'])]);
    toolsAvailable = true;
  } catch {
    toolsAvailable = false;
  }
  return toolsAvailable;
}

/** Test seam — lets the suite exercise the pipeline without libjxl installed. */
export function __setEncoderAvailable(value: boolean | null): void {
  toolsAvailable = value;
}

/* ── the codec ───────────────────────────────────────────────────────────── */

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fling-shrink-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Encodes and then *verifies by decoding*. Returns the encoded bytes only when
 * the decode reproduced the input exactly; null means "leave this file alone".
 */
export async function encodeJpegVerified(original: Buffer): Promise<Buffer | null> {
  if (!(await encoderAvailable())) return null;

  return withTempDir(async (dir) => {
    const src = path.join(dir, 'in.jpg');
    const enc = path.join(dir, 'out.jxl');
    const back = path.join(dir, 'back.jpg');

    await fsp.writeFile(src, original);
    try {
      await run('cjxl', ['--lossless_jpeg=1', '-q', '100', src, enc], { timeout: 120_000 });
      await run('djxl', [enc, back], { timeout: 120_000 });
    } catch {
      return null;
    }

    const encoded = await fsp.readFile(enc);
    const reconstructed = await fsp.readFile(back);

    // The whole feature rests on this comparison.
    if (sha256(reconstructed) !== sha256(original)) return null;
    if (encoded.length >= original.length * (1 - BOUNDS.minSaving)) return null;

    return encoded;
  });
}

/** Turns a stored blob back into the sender's original bytes. */
export async function decode(file: FileRow): Promise<Buffer> {
  const stored = await readStored(file);
  if (file.codec !== 'jxl') return stored;

  if (!(await encoderAvailable())) {
    // The bytes are intact, but this build cannot read them. Say so plainly
    // rather than surfacing a bare ENOENT from a spawn.
    throw new Error(
      `cannot decode ${file.id}: it is stored as JPEG XL but libjxl (djxl) is not installed`,
    );
  }

  return withTempDir(async (dir) => {
    const enc = path.join(dir, 'in.jxl');
    const out = path.join(dir, 'out.jpg');
    await fsp.writeFile(enc, stored);
    await run('djxl', [enc, out], { timeout: 120_000 });
    return fsp.readFile(out);
  });
}

/* ── per-file pass ───────────────────────────────────────────────────────── */

export type ShrinkOutcome =
  | { status: 'shrunk'; codec: FileCodec; before: number; after: number }
  | { status: 'skipped'; reason: string };

function eligible(file: FileRow): string | null {
  if (file.complete !== 1) return 'incomplete';
  if (file.codec) return 'already-encoded';
  if (file.size < BOUNDS.min) return 'too-small';
  if (file.size > BOUNDS.max) return 'too-large';
  if (!JPEG_EXTENSIONS.has(extensionOf(file.path))) return 'unsupported-type';
  return null;
}

/**
 * Ordering matters and is deliberately biased toward leaking a file rather than
 * losing one: the new blob is written and fsync'd first, and only then is the
 * row flipped. A crash in between leaves an unreferenced blob, never a row
 * pointing at bytes that are not there.
 *
 * The superseded original is **not** deleted here. A download resolves its
 * `FileRow` when the request starts but opens the blob lazily — for a zip, that
 * can be minutes later, once the archive writer reaches that entry. Unlinking
 * the moment the row flips would pull the file out from under a reader that has
 * already decided which variant to read. `cleanup.ts` reclaims it once no
 * in-flight request could still be holding the old row.
 */
export async function shrinkFile(file: FileRow): Promise<ShrinkOutcome> {
  const reason = eligible(file);
  if (reason) {
    q.markShrinkSkipped.run(file.id);
    return { status: 'skipped', reason };
  }

  let original: Buffer;
  try {
    original = await readStored(file);
  } catch {
    q.markShrinkSkipped.run(file.id);
    return { status: 'skipped', reason: 'unreadable' };
  }

  if (original.length !== file.size) {
    q.markShrinkSkipped.run(file.id);
    return { status: 'skipped', reason: 'size-mismatch' };
  }

  const encoded = await encodeJpegVerified(original);
  if (!encoded) {
    q.markShrinkSkipped.run(file.id);
    return { status: 'skipped', reason: 'no-gain-or-unverified' };
  }

  await writeWholeBlob(file.transfer_id, file.id, 'jxl', file.chunk_size, encoded);
  q.markShrunk.run('jxl', encoded.length, file.id);

  return { status: 'shrunk', codec: 'jxl', before: original.length, after: encoded.length };
}

/* ── background worker ───────────────────────────────────────────────────── */

let running = false;
let timer: NodeJS.Timeout | null = null;

/**
 * Strictly serial, and paced. This runs on someone's NAS next to Plex — it is
 * never worth finishing sooner at the cost of making the box feel busy.
 */
export async function runShrinkPass(batch = 4): Promise<number> {
  if (running) return 0;
  if (!getSettings().shrinkEnabled) return 0;
  if (!(await encoderAvailable())) return 0;

  running = true;
  let shrunk = 0;
  try {
    for (const file of q.shrinkCandidates.all(batch)) {
      const result = await shrinkFile(file);
      if (result.status === 'shrunk') shrunk++;
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    running = false;
  }
  return shrunk;
}

export function startShrinkWorker(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void runShrinkPass().catch(() => {
      /* a failed pass is retried on the next tick */
    });
  }, intervalMs);
  timer.unref();
}

export function stopShrinkWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Reclaims originals whose replacement has been live long enough that no reader
 * can still be holding the pre-shrink row. Driven by the cleanup loop.
 */
export async function sweepSupersededBlobs(batch = 500): Promise<number> {
  const now = Date.now();
  let removed = 0;

  for (const file of q.unsweptFiles.all(batch)) {
    const original = blobPath(file.transfer_id, file.id, null);
    try {
      const live = await fsp.stat(blobPath(file.transfer_id, file.id, file.codec));
      if (now - live.mtimeMs < BOUNDS.sweepGraceMs) continue;
    } catch {
      // Replacement unreadable. If the original is gone too there is nothing to
      // reclaim, so retire the row rather than re-examining it on every pass
      // forever — those rows would otherwise fill the batch and starve real work.
      // If the original *is* still there it is the only copy, so leave it be.
      if (!(await fsp.stat(original).catch(() => null))) q.markSwept.run(file.id);
      continue;
    }
    await removeBlob(file.transfer_id, file.id, null).catch(() => undefined);
    q.markSwept.run(file.id);
    removed++;
  }
  return removed;
}

/** Numbers for the admin page. */
export function shrinkStats() {
  const totals = q.shrinkTotals.get() ?? { logical: 0, stored: 0, shrunk: 0 };
  const saved = Math.max(0, totals.logical - totals.stored);
  return {
    logicalBytes: totals.logical,
    storedBytes: totals.stored,
    savedBytes: saved,
    savedPercent: totals.logical > 0 ? (saved / totals.logical) * 100 : 0,
    filesShrunk: totals.shrunk,
    filesPending: q.pendingShrinkCount.get()?.n ?? 0,
  };
}

export { storedSizeOf };
