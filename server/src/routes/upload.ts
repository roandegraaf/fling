import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CHUNK_SIZE, hashPassword, randomToken, safeEqual, sha256 } from '../crypto.ts';
import {
  db,
  hasBit,
  missingChunks,
  newBitmap,
  q,
  setBit,
  type TransferRow,
} from '../db.ts';
import { getSettings } from '../settings.ts';
import { sanitizeRelPath, ancestorsOf } from '../paths.ts';
import { generateSlug } from '../slug.ts';
import {
  chunkCountFor,
  deleteTransferBlobs,
  plainChunkLength,
  transferDir,
  writeChunk,
} from '../storage.ts';
import { publicUrlFor } from '../url.ts';
import fsp from 'node:fs/promises';

const MAX_PASSWORD_LENGTH = 256;
const MAX_DOWNLOAD_LIMIT = 100_000;

interface CreateBody {
  files?: Array<{ path?: unknown; size?: unknown }>;
  dirs?: unknown[];
  expiryDays?: unknown;
  password?: unknown;
  downloadLimit?: unknown;
}

/** Bearer token in the header, or `?t=` for convenience. */
function tokenFrom(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const fromQuery = (req.query as Record<string, unknown> | undefined)?.t;
  return typeof fromQuery === 'string' ? fromQuery : null;
}

function ownsTransfer(req: FastifyRequest, transfer: TransferRow): boolean {
  const token = tokenFrom(req);
  return !!token && safeEqual(sha256(token), transfer.upload_token_hash);
}

/** Makes duplicate paths unique instead of rejecting the whole transfer. */
function dedupePaths(paths: string[]): string[] {
  const seen = new Map<string, number>();
  return paths.map((original) => {
    const key = original.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count === 0) return original;

    const slash = original.lastIndexOf('/');
    const dir = slash === -1 ? '' : original.slice(0, slash + 1);
    const name = slash === -1 ? original : original.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    return `${dir}${stem} (${count + 1})${ext}`;
  });
}

export function registerUploadRoutes(app: FastifyInstance): void {
  /* ── create a transfer ─────────────────────────────────────────────────── */
  app.post('/api/transfers', async (req, reply) => {
    const body = (req.body ?? {}) as CreateBody;
    const settings = getSettings();

    if (!Array.isArray(body.files) || body.files.length === 0) {
      return reply.code(400).send({ error: 'no_files', message: 'Add at least one file.' });
    }
    if (body.files.length > settings.maxFileCount) {
      return reply.code(400).send({
        error: 'too_many_files',
        message: `This server accepts at most ${settings.maxFileCount} files per transfer.`,
      });
    }

    const paths: string[] = [];
    const sizes: number[] = [];
    let totalSize = 0;

    for (const entry of body.files) {
      const relPath = sanitizeRelPath(entry?.path);
      if (!relPath) {
        return reply.code(400).send({ error: 'bad_path', message: 'A file name was not usable.' });
      }
      const size = Number(entry?.size);
      if (!Number.isSafeInteger(size) || size < 0) {
        return reply.code(400).send({ error: 'bad_size', message: `Bad size for ${relPath}.` });
      }
      if (size > settings.maxFileSize) {
        return reply.code(413).send({
          error: 'file_too_large',
          message: `${relPath} is larger than the ${formatBytes(settings.maxFileSize)} per-file limit.`,
        });
      }
      paths.push(relPath);
      sizes.push(size);
      totalSize += size;
    }

    if (totalSize > settings.maxTransferSize) {
      return reply.code(413).send({
        error: 'transfer_too_large',
        message: `This transfer is larger than the ${formatBytes(settings.maxTransferSize)} limit.`,
      });
    }

    if (settings.storageQuotaBytes > 0) {
      const stored = q.totalStoredBytes.get()?.total ?? 0;
      if (stored + totalSize > settings.storageQuotaBytes) {
        return reply.code(507).send({
          error: 'storage_full',
          message: 'The server is out of space for new transfers.',
        });
      }
    }

    const expiryDays = clampInt(
      Number(body.expiryDays ?? settings.defaultExpiryDays),
      1,
      settings.maxExpiryDays,
    );

    let downloadLimit: number | null = null;
    if (body.downloadLimit !== null && body.downloadLimit !== undefined && body.downloadLimit !== '') {
      const parsed = Number(body.downloadLimit);
      if (Number.isFinite(parsed) && parsed > 0) {
        downloadLimit = clampInt(parsed, 1, MAX_DOWNLOAD_LIMIT);
      }
    }

    let passwordHash: string | null = null;
    if (typeof body.password === 'string' && body.password.length > 0) {
      if (body.password.length > MAX_PASSWORD_LENGTH) {
        return reply.code(400).send({ error: 'password_too_long' });
      }
      passwordHash = hashPassword(body.password);
    }

    const emptyDirs = new Set<string>();
    if (Array.isArray(body.dirs)) {
      for (const raw of body.dirs) {
        const clean = sanitizeRelPath(raw);
        if (clean) emptyDirs.add(clean);
      }
    }
    // A folder that already contains a file is implied by that file's path.
    for (const filePath of paths) {
      emptyDirs.delete(filePath);
      for (const ancestor of ancestorsOf(filePath)) emptyDirs.delete(ancestor);
    }

    const uniquePaths = dedupePaths(paths);
    const transferId = randomUUID();
    const uploadToken = randomToken(32);
    const now = Date.now();

    const slug = pickFreeSlug();
    if (!slug) {
      return reply.code(503).send({ error: 'slug_exhausted', message: 'Could not allocate a link.' });
    }

    const fileRecords = uniquePaths.map((relPath, index) => ({
      id: randomUUID(),
      transfer_id: transferId,
      path: relPath,
      size: sizes[index],
      chunk_size: CHUNK_SIZE,
      chunk_count: chunkCountFor(sizes[index], CHUNK_SIZE),
      received_bitmap: newBitmap(chunkCountFor(sizes[index], CHUNK_SIZE)),
      complete: sizes[index] === 0 ? 1 : 0,
      sort_order: index,
    }));

    const create = db.transaction(() => {
      q.insertTransfer.run({
        id: transferId,
        slug,
        created_at: now,
        expires_at: now + expiryDays * 86_400_000,
        password_hash: passwordHash,
        download_limit: downloadLimit,
        upload_token_hash: sha256(uploadToken),
        total_size: totalSize,
        file_count: fileRecords.length,
        sender_ip: req.ip ?? null,
      });
      for (const file of fileRecords) q.insertFile.run(file);
      for (const dir of emptyDirs) q.insertDir.run(transferId, dir);
    });

    try {
      create();
      // Fail fast if the data share is not writable, rather than at first chunk.
      await fsp.mkdir(transferDir(transferId), { recursive: true });
    } catch (err) {
      req.log.error({ err }, 'failed to create transfer');
      try {
        q.deleteTransfer.run(transferId);
      } catch {
        /* nothing to undo */
      }
      return reply.code(500).send({ error: 'create_failed', message: 'Could not start the transfer.' });
    }

    return reply.send({
      transferId,
      slug,
      uploadToken,
      url: publicUrlFor(req, slug),
      expiresAt: now + expiryDays * 86_400_000,
      chunkSize: CHUNK_SIZE,
      files: fileRecords.map((f) => ({
        id: f.id,
        path: f.path,
        size: f.size,
        chunkSize: f.chunk_size,
        chunkCount: f.chunk_count,
        complete: f.complete === 1,
      })),
    });
  });

  /* ── compact sender-side view, used by the local history list ──────────── */
  app.get<{ Params: { id: string } }>('/api/transfers/:id/info', async (req, reply) => {
    const transfer = q.transferById.get(req.params.id);
    if (!transfer) return reply.code(404).send({ error: 'not_found' });
    if (!ownsTransfer(req, transfer)) return reply.code(403).send({ error: 'forbidden' });

    return reply.send({
      transferId: transfer.id,
      slug: transfer.slug,
      url: publicUrlFor(req, transfer.slug),
      status: transfer.status,
      createdAt: transfer.created_at,
      expiresAt: transfer.expires_at,
      expired: transfer.expires_at <= Date.now(),
      totalSize: transfer.total_size,
      fileCount: transfer.file_count,
      hasPassword: !!transfer.password_hash,
      downloadLimit: transfer.download_limit,
      downloadCount: transfer.download_count,
      lastDownloadAt: transfer.last_download_at,
    });
  });

  /* ── resume: what does the server already have? ────────────────────────── */
  app.get<{ Params: { id: string } }>('/api/transfers/:id/status', async (req, reply) => {
    const transfer = q.transferById.get(req.params.id);
    if (!transfer) return reply.code(404).send({ error: 'not_found' });
    if (!ownsTransfer(req, transfer)) return reply.code(403).send({ error: 'forbidden' });

    const files = q.filesOfTransfer.all(transfer.id);
    return reply.send({
      transferId: transfer.id,
      slug: transfer.slug,
      status: transfer.status,
      expiresAt: transfer.expires_at,
      chunkSize: CHUNK_SIZE,
      files: files.map((f) => ({
        id: f.id,
        path: f.path,
        size: f.size,
        chunkSize: f.chunk_size,
        chunkCount: f.chunk_count,
        receivedCount: f.received_count,
        complete: f.complete === 1,
        // Base64 bitmap keeps this small even for a 20 GB file (640 bytes).
        received: f.received_bitmap.toString('base64'),
        missing: f.complete === 1 ? [] : missingChunks(f.received_bitmap, f.chunk_count, 4096),
      })),
    });
  });

  /* ── upload one chunk ──────────────────────────────────────────────────── */
  app.put<{ Params: { id: string; fileId: string; index: string } }>(
    '/api/transfers/:id/files/:fileId/chunks/:index',
    { bodyLimit: CHUNK_SIZE + 1024 },
    async (req, reply) => {
      const transfer = q.transferById.get(req.params.id);
      if (!transfer) return reply.code(404).send({ error: 'not_found' });
      if (!ownsTransfer(req, transfer)) return reply.code(403).send({ error: 'forbidden' });
      if (transfer.expires_at <= Date.now()) {
        return reply.code(410).send({ error: 'expired' });
      }
      if (transfer.status !== 'uploading') {
        return reply.code(409).send({ error: 'already_finalized' });
      }

      const file = q.fileById.get(req.params.fileId);
      if (!file || file.transfer_id !== transfer.id) {
        return reply.code(404).send({ error: 'file_not_found' });
      }

      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0 || index >= file.chunk_count) {
        return reply.code(400).send({ error: 'bad_chunk_index' });
      }

      const body = req.body;
      if (!Buffer.isBuffer(body)) {
        return reply.code(400).send({ error: 'bad_body', message: 'Expected a binary chunk body.' });
      }

      const expected = plainChunkLength(file.size, file.chunk_size, index);
      if (body.length !== expected) {
        return reply.code(400).send({
          error: 'bad_chunk_size',
          message: `Chunk ${index} should be ${expected} bytes, got ${body.length}.`,
        });
      }

      // Already have it (a retry that actually succeeded the first time).
      if (hasBit(file.received_bitmap, index)) {
        return reply.send({ ok: true, duplicate: true, receivedCount: file.received_count });
      }

      try {
        await writeChunk(transfer.id, file.id, index, file.chunk_size, file.size, body);
      } catch (err) {
        req.log.error({ err, fileId: file.id, index }, 'chunk write failed');
        return reply.code(500).send({ error: 'write_failed' });
      }

      // Re-read: a concurrent chunk for the same file may have moved the bitmap on.
      const fresh = q.fileById.get(file.id);
      if (!fresh) return reply.code(404).send({ error: 'file_not_found' });

      const bitmap = Buffer.from(fresh.received_bitmap);
      const changed = setBit(bitmap, index);
      const receivedCount = changed ? fresh.received_count + 1 : fresh.received_count;
      const complete = receivedCount >= fresh.chunk_count ? 1 : 0;
      q.updateFileProgress.run(bitmap, receivedCount, complete, file.id);

      return reply.send({ ok: true, receivedCount, complete: complete === 1 });
    },
  );

  /* ── finalize ──────────────────────────────────────────────────────────── */
  app.post<{ Params: { id: string } }>('/api/transfers/:id/finalize', async (req, reply) => {
    const transfer = q.transferById.get(req.params.id);
    if (!transfer) return reply.code(404).send({ error: 'not_found' });
    if (!ownsTransfer(req, transfer)) return reply.code(403).send({ error: 'forbidden' });

    const files = q.filesOfTransfer.all(transfer.id);
    const incomplete = files.filter((f) => f.complete !== 1);
    if (incomplete.length > 0) {
      return reply.code(409).send({
        error: 'incomplete',
        message: `${incomplete.length} file(s) still have missing chunks.`,
        files: incomplete.map((f) => ({
          id: f.id,
          path: f.path,
          missing: missingChunks(f.received_bitmap, f.chunk_count, 4096),
        })),
      });
    }

    if (transfer.status !== 'complete') {
      q.markTransferComplete.run(Date.now(), transfer.id);
    }

    const updated = q.transferById.get(transfer.id)!;
    return reply.send({
      transferId: updated.id,
      slug: updated.slug,
      url: publicUrlFor(req, updated.slug),
      expiresAt: updated.expires_at,
      totalSize: updated.total_size,
      fileCount: updated.file_count,
      hasPassword: !!updated.password_hash,
      downloadLimit: updated.download_limit,
      downloadCount: updated.download_count,
    });
  });

  /* ── sender-side delete ───────────────────────────────────────────────── */
  app.delete<{ Params: { id: string } }>('/api/transfers/:id', async (req, reply) => {
    const transfer = q.transferById.get(req.params.id);
    if (!transfer) return reply.code(404).send({ error: 'not_found' });
    if (!ownsTransfer(req, transfer)) return reply.code(403).send({ error: 'forbidden' });

    q.deleteTransfer.run(transfer.id);
    await deleteTransferBlobs(transfer.id).catch((err) =>
      req.log.error({ err, transferId: transfer.id }, 'blob delete failed'),
    );
    return reply.send({ ok: true });
  });
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function pickFreeSlug(): string | null {
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidate = generateSlug();
    if (!q.transferBySlug.get(candidate)) return candidate;
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

