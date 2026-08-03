import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashPassword, masterKeySource, randomToken, verifyPassword } from '../crypto.ts';
import { dbFileSize, q } from '../db.ts';
import { BLOB_DIR, CONFIG_DIR, DATA_DIR } from '../env.ts';
import { runCleanup } from '../cleanup.ts';
import {
  EXPIRY_DAYS_CEILING,
  getSettings,
  setAdminPasswordHash,
  updateSettings,
  type Settings,
} from '../settings.ts';
import { deleteTransferBlobs, diskUsage } from '../storage.ts';

const COOKIE = 'fling_admin';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const EDITABLE_KEYS: (keyof Settings)[] = [
  'maxTransferSize',
  'maxFileSize',
  'maxFileCount',
  'maxExpiryDays',
  'defaultExpiryDays',
  'storageQuotaBytes',
  'incompleteUploadTtlHours',
  'cleanupIntervalMinutes',
];

function isSetUp(): boolean {
  return getSettings().adminPasswordHash !== '';
}

function sessionIdOf(req: FastifyRequest): string | null {
  const raw = req.cookies?.[COOKIE];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function isAuthenticated(req: FastifyRequest): boolean {
  const id = sessionIdOf(req);
  if (!id) return false;
  const session = q.adminSession.get(id);
  if (!session) return false;
  if (session.expires_at <= Date.now()) {
    q.deleteAdminSession.run(id);
    return false;
  }
  return true;
}

function setSessionCookie(req: FastifyRequest, reply: FastifyReply, id: string): void {
  const secure =
    req.protocol === 'https' ||
    String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() === 'https';
  reply.setCookie(COOKIE, id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/** Guard used by every route below except session/setup/login. */
async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isAuthenticated(req)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
}

export function registerAdminRoutes(app: FastifyInstance): void {
  /* ── session ───────────────────────────────────────────────────────────── */
  app.get('/api/admin/session', async (req) => ({
    authenticated: isAuthenticated(req),
    needsSetup: !isSetUp(),
  }));

  /** First-run: set the password when none exists yet. */
  app.post<{ Body: { password?: unknown } }>(
    '/api/admin/setup',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (isSetUp()) return reply.code(409).send({ error: 'already_set_up' });

      const password = (req.body ?? {}).password;
      if (typeof password !== 'string' || password.length < 8) {
        return reply
          .code(400)
          .send({ error: 'weak_password', message: 'Use at least 8 characters.' });
      }

      setAdminPasswordHash(hashPassword(password));
      const id = randomToken(24);
      q.insertAdminSession.run(id, Date.now(), Date.now() + SESSION_TTL_MS);
      setSessionCookie(req, reply, id);
      return reply.send({ ok: true });
    },
  );

  app.post<{ Body: { password?: unknown } }>(
    '/api/admin/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!isSetUp()) return reply.code(409).send({ error: 'needs_setup' });

      const password = (req.body ?? {}).password;
      if (typeof password !== 'string' || !verifyPassword(password, getSettings().adminPasswordHash)) {
        return reply.code(401).send({ error: 'bad_password', message: 'That password is not right.' });
      }

      const id = randomToken(24);
      q.insertAdminSession.run(id, Date.now(), Date.now() + SESSION_TTL_MS);
      setSessionCookie(req, reply, id);
      return reply.send({ ok: true });
    },
  );

  app.post('/api/admin/logout', async (req, reply) => {
    const id = sessionIdOf(req);
    if (id) q.deleteAdminSession.run(id);
    reply.clearCookie(COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  /* ── settings ──────────────────────────────────────────────────────────── */
  app.get('/api/admin/settings', { preHandler: requireAdmin }, async () => {
    const s = getSettings();
    return {
      settings: Object.fromEntries(EDITABLE_KEYS.map((k) => [k, s[k]])),
      expiryDaysCeiling: EXPIRY_DAYS_CEILING,
    };
  });

  app.put<{ Body: Record<string, unknown> }>(
    '/api/admin/settings',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const patch: Partial<Settings> = {};
      for (const key of EDITABLE_KEYS) {
        const value = req.body?.[key];
        if (value === undefined || value === null || value === '') continue;
        const num = Number(value);
        if (Number.isFinite(num)) (patch[key] as number) = num;
      }
      const updated = updateSettings(patch);
      return reply.send({
        settings: Object.fromEntries(EDITABLE_KEYS.map((k) => [k, updated[k]])),
        expiryDaysCeiling: EXPIRY_DAYS_CEILING,
      });
    },
  );

  app.post<{ Body: { currentPassword?: unknown; newPassword?: unknown } }>(
    '/api/admin/password',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { currentPassword, newPassword } = req.body ?? {};
      if (
        typeof currentPassword !== 'string' ||
        !verifyPassword(currentPassword, getSettings().adminPasswordHash)
      ) {
        return reply.code(401).send({ error: 'bad_password' });
      }
      if (typeof newPassword !== 'string' || newPassword.length < 8) {
        return reply.code(400).send({ error: 'weak_password', message: 'Use at least 8 characters.' });
      }
      setAdminPasswordHash(hashPassword(newPassword));
      return reply.send({ ok: true });
    },
  );

  /* ── transfers ─────────────────────────────────────────────────────────── */
  app.get('/api/admin/transfers', { preHandler: requireAdmin }, async () => {
    const now = Date.now();
    const rows = q.allTransfers.all();
    return {
      transfers: rows.map((t) => ({
        id: t.id,
        slug: t.slug,
        createdAt: t.created_at,
        expiresAt: t.expires_at,
        completedAt: t.completed_at,
        lastDownloadAt: t.last_download_at,
        status: t.status,
        totalSize: t.total_size,
        fileCount: t.file_count,
        hasPassword: !!t.password_hash,
        downloadLimit: t.download_limit,
        downloadCount: t.download_count,
        senderIp: t.sender_ip,
        expired: t.expires_at <= now,
      })),
    };
  });

  app.delete<{ Params: { id: string } }>(
    '/api/admin/transfers/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const transfer = q.transferById.get(req.params.id);
      if (!transfer) return reply.code(404).send({ error: 'not_found' });

      q.deleteTransfer.run(transfer.id);
      await deleteTransferBlobs(transfer.id).catch((err) =>
        req.log.error({ err, transferId: transfer.id }, 'blob delete failed'),
      );
      return reply.send({ ok: true });
    },
  );

  /* ── stats & maintenance ───────────────────────────────────────────────── */
  app.get('/api/admin/stats', { preHandler: requireAdmin }, async () => {
    const now = Date.now();
    const rows = q.allTransfers.all();
    const active = rows.filter((t) => t.status === 'complete' && t.expires_at > now);
    const uploading = rows.filter((t) => t.status === 'uploading');

    return {
      transfers: {
        total: rows.length,
        active: active.length,
        uploading: uploading.length,
        expired: rows.filter((t) => t.expires_at <= now).length,
      },
      storage: {
        logicalBytes: q.totalStoredBytes.get()?.total ?? 0,
        onDiskBytes: await diskUsage(),
        databaseBytes: dbFileSize(),
        blobDir: BLOB_DIR,
        dataDir: DATA_DIR,
        configDir: CONFIG_DIR,
      },
      encryption: {
        algorithm: 'AES-256-GCM, per-file key, 4 MiB chunks',
        // Surfaced so it is obvious that losing this key loses every file.
        masterKeySource: masterKeySource(),
      },
    };
  });

  app.post('/api/admin/cleanup', { preHandler: requireAdmin }, async (req, reply) => {
    const result = await runCleanup(req.log);
    return reply.send(result);
  });
}

