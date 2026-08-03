import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { clientFingerprint, signSession, verifyPassword, verifySession } from '../crypto.ts';
import { q, type DownloadSessionRow, type FileRow, type TransferRow } from '../db.ts';
import { ERRORS, sendFriendly, type FriendlyError } from '../errorPage.ts';
import { contentDisposition, mimeFor } from '../mime.ts';
import { basenameOf, isInsideFolder, safeDownloadName } from '../paths.ts';
import { normalizeSlug } from '../slug.ts';
import { createDecryptedStream } from '../storage.ts';
import { buildTree } from '../tree.ts';
import { createZip, type ZipEntry } from '../zip.ts';

/** Backstop for a tab left open for days; the session row is the real record. */
const ACCESS_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * How long a visitor is still recognised as "the same person coming back".
 * Clicking the link again from an email opens a new tab and loses the token, so
 * without this a re-click would spend a second download.
 */
const RETURN_WINDOW_MS = 6 * 60 * 60 * 1000;

function tokenFrom(req: FastifyRequest): string | null {
  const fromQuery = (req.query as Record<string, unknown> | undefined)?.k;
  if (typeof fromQuery === 'string') return fromQuery;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/** The session this request belongs to, if it carries a valid token for it. */
function sessionFor(req: FastifyRequest, transfer: TransferRow): DownloadSessionRow | null {
  const id = verifySession(transfer.slug, tokenFrom(req));
  if (!id) return null;
  const session = q.downloadSession.get(id);
  return session && session.transfer_id === transfer.id ? session : null;
}

function limitReached(transfer: TransferRow): boolean {
  return transfer.download_limit !== null && transfer.download_count >= transfer.download_limit;
}

/**
 * A transfer only needs a session token when the sender put a control on it.
 * An open, unlimited link keeps working as a plain URL.
 */
function needsSession(transfer: TransferRow): boolean {
  return !!transfer.password_hash || transfer.download_limit !== null;
}

type Lookup =
  | { ok: true; transfer: TransferRow }
  | { ok: false; error: FriendlyError };

function lookup(rawSlug: string): Lookup {
  const slug = normalizeSlug(rawSlug);
  const transfer = q.transferBySlug.get(slug);

  if (!transfer || transfer.status !== 'complete') {
    return { ok: false, error: ERRORS.notFound() };
  }
  if (transfer.expires_at <= Date.now()) {
    return { ok: false, error: ERRORS.expired() };
  }
  return { ok: true, transfer };
}

/**
 * Counting rule: one "download" is one person actually taking the files — not
 * one file, and not merely looking at the page.
 *
 *  - Opening the transfer costs nothing, so a recipient can check what is there
 *    and come back later without spending the sender's allowance.
 *  - The first file, folder zip or download-all in a session spends exactly one,
 *    however many more they then fetch.
 *  - A visitor returning within RETURN_WINDOW_MS reuses their session, so
 *    re-clicking the link from an email is free.
 */
function openSession(req: FastifyRequest, transfer: TransferRow): DownloadSessionRow {
  const now = Date.now();
  const fingerprint = clientFingerprint(req.ip, transfer.id);

  const existing = fingerprint
    ? q.reusableDownloadSession.get(transfer.id, fingerprint, now - RETURN_WINDOW_MS)
    : undefined;

  if (existing) {
    q.touchDownloadSession.run(now, existing.id);
    return { ...existing, last_seen_at: now };
  }

  const session: DownloadSessionRow = {
    id: randomUUID(),
    transfer_id: transfer.id,
    fingerprint,
    created_at: now,
    last_seen_at: now,
    counted: 0,
  };
  q.insertDownloadSession.run(
    session.id,
    session.transfer_id,
    session.fingerprint,
    session.created_at,
    session.last_seen_at,
  );
  return session;
}

/**
 * Charges this session against the limit, the first time it actually fetches
 * something. Returns false when the allowance ran out in the meantime — the
 * limit is enforced here rather than at page-open, so it can't be beaten by
 * opening several tabs before downloading.
 */
function chargeSession(transfer: TransferRow, session: DownloadSessionRow): boolean {
  const now = Date.now();

  if (session.counted === 1) {
    q.touchDownloadSession.run(now, session.id);
    return true;
  }

  const fresh = q.transferById.get(transfer.id) ?? transfer;
  if (limitReached(fresh)) return false;

  try {
    q.bumpDownloadCount.run(now, transfer.id);
    q.markDownloadSessionCounted.run(now, session.id);
    session.counted = 1;
  } catch {
    /* counting must never break the download itself */
  }
  return true;
}

function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return 'invalid';

  let start: number;
  let end: number;

  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start > end || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

/** Shared gate for the two download endpoints. */
function authorizeDownload(
  req: FastifyRequest,
  rawSlug: string,
): { ok: true; transfer: TransferRow } | { ok: false; error: FriendlyError } {
  const found = lookup(rawSlug);
  if (!found.ok) return found;

  const { transfer } = found;

  // An open link — no password, no limit — stays a plain URL that can be
  // forwarded, so it is never refused. A session is still opened and charged so
  // the sender's "Downloads" figure stays meaningful; with no limit set,
  // chargeSession can't fail.
  if (!needsSession(transfer)) {
    const session = sessionFor(req, transfer) ?? openSession(req, transfer);
    chargeSession(transfer, session);
    return { ok: true, transfer };
  }

  let session = sessionFor(req, transfer);

  if (!session) {
    if (transfer.password_hash) {
      return { ok: false, error: ERRORS.passwordRequired(transfer.slug) };
    }
    // A limited link opened straight to the file URL, or a tab that was closed.
    // Recognise them if they were here recently; otherwise send them to the page.
    const fingerprint = clientFingerprint(req.ip, transfer.id);
    const returning = fingerprint
      ? q.reusableDownloadSession.get(transfer.id, fingerprint, Date.now() - RETURN_WINDOW_MS)
      : undefined;
    if (!returning) {
      return {
        ok: false,
        error: limitReached(transfer)
          ? ERRORS.limitReached(transfer.slug)
          : ERRORS.sessionExpired(transfer.slug),
      };
    }
    session = returning;
  }

  if (!chargeSession(transfer, session)) {
    return { ok: false, error: ERRORS.limitReached(transfer.slug) };
  }

  return { ok: true, transfer };
}

export function registerDownloadRoutes(app: FastifyInstance): void {
  /* ── manifest — this is what starts a session ──────────────────────────── */
  app.get<{ Params: { slug: string } }>(
    '/api/t/:slug',
    // Slows brute-force scanning of the slug space to a crawl.
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const found = lookup(req.params.slug);
      if (!found.ok) return sendFriendly(req, reply, found.error);

      const { transfer } = found;

      if (transfer.password_hash && !sessionFor(req, transfer)) {
        return reply
          .code(401)
          .send({ error: 'password_required', passwordRequired: true, slug: transfer.slug });
      }

      const files = q.filesOfTransfer.all(transfer.id);
      const emptyDirs = q.dirsOfTransfer.all(transfer.id).map((d) => d.path);

      // Viewing is free — a session is opened but nothing is charged until they
      // actually fetch something. Only refuse when the allowance is already gone
      // and this is not someone who already claimed one.
      const session = sessionFor(req, transfer) ?? openSession(req, transfer);
      const usable = session.counted === 1 || !limitReached(transfer);

      return reply.send({
        ...manifestBody(transfer, files, emptyDirs),
        limitReached: !usable,
        accessToken: usable ? signSession(transfer.slug, session.id, ACCESS_TTL_MS) : null,
      });
    },
  );

  /* ── unlock a password-protected transfer ──────────────────────────────── */
  app.post<{ Params: { slug: string }; Body: { password?: unknown } }>(
    '/api/t/:slug/unlock',
    { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const found = lookup(req.params.slug);
      if (!found.ok) return reply.code(found.error.status).send({ error: found.error.code });

      const { transfer } = found;
      if (!transfer.password_hash) {
        return reply.send({ token: null, hasPassword: false });
      }

      const password = (req.body ?? {}).password;
      if (typeof password !== 'string' || !verifyPassword(password, transfer.password_hash)) {
        return reply.code(401).send({ error: 'bad_password', message: 'That password is not right.' });
      }

      const session = sessionFor(req, transfer) ?? openSession(req, transfer);
      if (session.counted !== 1 && limitReached(transfer)) {
        return reply
          .code(410)
          .send({ error: 'limit_reached', message: ERRORS.limitReached(transfer.slug).message });
      }

      return reply.send({
        token: signSession(transfer.slug, session.id, ACCESS_TTL_MS),
        hasPassword: true,
      });
    },
  );

  /* ── one file, with Range support ──────────────────────────────────────── */
  app.get<{ Params: { slug: string; fileId: string } }>(
    '/api/t/:slug/file/:fileId',
    async (req, reply) => {
      const auth = authorizeDownload(req, req.params.slug);
      if (!auth.ok) return sendFriendly(req, reply, auth.error);

      const { transfer } = auth;
      const file = q.fileById.get(req.params.fileId);
      if (!file || file.transfer_id !== transfer.id || file.complete !== 1) {
        return sendFriendly(req, reply, ERRORS.fileMissing(transfer.slug));
      }

      const range = parseRange(req.headers.range, file.size);
      if (range === 'invalid') {
        return reply
          .code(416)
          .header('content-range', `bytes */${file.size}`)
          .send({ error: 'range_not_satisfiable' });
      }

      const name = basenameOf(file.path);
      reply
        .header('accept-ranges', 'bytes')
        .header('content-type', mimeFor(name))
        .header('content-disposition', contentDisposition(name))
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff');

      if (range) {
        reply
          .code(206)
          .header('content-range', `bytes ${range.start}-${range.end}/${file.size}`)
          .header('content-length', String(range.end - range.start + 1));
        return reply.send(createDecryptedStream(file, range.start, range.end));
      }

      reply.header('content-length', String(file.size));
      return reply.send(createDecryptedStream(file));
    },
  );

  /* ── zip: whole transfer, or one folder ────────────────────────────────── */
  app.get<{ Params: { slug: string }; Querystring: { path?: string } }>(
    '/api/t/:slug/zip',
    async (req, reply) => {
      const auth = authorizeDownload(req, req.params.slug);
      if (!auth.ok) return sendFriendly(req, reply, auth.error);

      const { transfer } = auth;
      const allFiles = q.filesOfTransfer.all(transfer.id).filter((f) => f.complete === 1);
      const allDirs = q.dirsOfTransfer.all(transfer.id).map((d) => d.path);

      const folder = typeof req.query.path === 'string' ? req.query.path.replace(/\/+$/, '') : '';
      let entries: ZipEntry[];
      let emptyDirs: string[];
      let zipName: string;

      if (folder) {
        const knownFolder =
          allDirs.includes(folder) || allFiles.some((f) => isInsideFolder(f.path, folder));
        if (!knownFolder) return sendFriendly(req, reply, ERRORS.fileMissing(transfer.slug));

        const base = basenameOf(folder);
        const strip = folder.length + 1;
        entries = allFiles
          .filter((f) => isInsideFolder(f.path, folder))
          .map((f) => ({ file: f, name: `${base}/${f.path.slice(strip)}` }));
        emptyDirs = allDirs
          .filter((d) => d !== folder && isInsideFolder(d, folder))
          .map((d) => `${base}/${d.slice(strip)}`);
        zipName = `${safeDownloadName(base, 'folder')}.zip`;
      } else {
        entries = allFiles.map((f) => ({ file: f, name: f.path }));
        emptyDirs = allDirs;
        zipName = `fling-${transfer.slug}.zip`;
      }

      if (entries.length === 0 && emptyDirs.length === 0) {
        return sendFriendly(req, reply, ERRORS.fileMissing(transfer.slug));
      }

      let built;
      try {
        built = await createZip(entries, emptyDirs, new Date(transfer.created_at), (err) =>
          // Fired after headers are already on the wire, so this is for the log.
          req.log.error({ err, transferId: transfer.id }, 'zip stream failed mid-download'),
        );
      } catch (err) {
        req.log.error({ err, transferId: transfer.id }, 'zip build failed');
        return sendFriendly(req, reply, ERRORS.zipFailed(transfer.slug));
      }

      reply
        .header('content-type', 'application/zip')
        .header('content-disposition', contentDisposition(zipName))
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff');

      // yazl pre-computes this because every entry is stored, not deflated —
      // so the browser shows a real progress bar instead of an unknown-size spinner.
      if (built.size >= 0) reply.header('content-length', String(built.size));

      return reply.send(built.stream);
    },
  );
}

function manifestBody(transfer: TransferRow, files: FileRow[], emptyDirs: string[]) {
  return {
    slug: transfer.slug,
    createdAt: transfer.created_at,
    expiresAt: transfer.expires_at,
    totalSize: transfer.total_size,
    fileCount: transfer.file_count,
    downloadLimit: transfer.download_limit,
    downloadCount: transfer.download_count,
    hasPassword: !!transfer.password_hash,
    tree: buildTree(files, emptyDirs),
  };
}

