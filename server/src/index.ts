import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import {
  ADMIN_PASSWORD_ENV,
  BLOB_DIR,
  CONFIG_DIR,
  DATA_DIR,
  HOST,
  PORT,
  PUBLIC_URL,
  TRUST_PROXY,
  WEB_DIST,
} from './env.ts';
import { CHUNK_SIZE, hashPassword, loadMasterKey, masterKeySource } from './crypto.ts';
import { closeDb } from './db.ts';
import { getSettings, publicSettings, setAdminPasswordHash } from './settings.ts';
import { startCleanupLoop } from './cleanup.ts';
import { registerUploadRoutes } from './routes/upload.ts';
import { registerDownloadRoutes } from './routes/download.ts';
import { registerAdminRoutes } from './routes/admin.ts';

fs.mkdirSync(BLOB_DIR, { recursive: true });

// Fail fast and loudly if the key cannot be resolved — every blob depends on it.
loadMasterKey();

if (ADMIN_PASSWORD_ENV) {
  setAdminPasswordHash(hashPassword(ADMIN_PASSWORD_ENV));
}

const app = Fastify({
  trustProxy: TRUST_PROXY,
  // One 4 MiB chunk plus headroom. Chunk routes set their own limit too.
  bodyLimit: CHUNK_SIZE + 1024 * 1024,
  logger: { level: process.env.FLING_LOG_LEVEL ?? 'info' },
  disableRequestLogging: process.env.FLING_LOG_LEVEL !== 'debug',
});

/** Chunk uploads arrive as a raw binary body. */
app.addContentTypeParser(
  'application/octet-stream',
  { parseAs: 'buffer' },
  (_req, body, done) => done(null, body),
);

await app.register(cookie);
await app.register(rateLimit, {
  global: false,
  max: 300,
  timeWindow: '1 minute',
});

app.get('/api/health', async () => ({ ok: true }));

app.get('/api/config', async () => ({
  ...publicSettings(),
  chunkSize: CHUNK_SIZE,
  publicUrl: PUBLIC_URL || null,
}));

registerUploadRoutes(app);
registerDownloadRoutes(app);
registerAdminRoutes(app);

/* ── static SPA ──────────────────────────────────────────────────────────── */

const INDEX_HTML = path.join(WEB_DIST, 'index.html');
const hasBuiltWeb = fs.existsSync(INDEX_HTML);
// Read once at boot: the SPA fallback below is on the path of every deep link.
const indexHtml = hasBuiltWeb ? fs.readFileSync(INDEX_HTML) : null;

if (hasBuiltWeb) {
  await app.register(fastifyStatic, {
    root: WEB_DIST,
    prefix: '/',
    // Hashed asset filenames can be cached hard; index.html must not be.
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) {
        res.setHeader('cache-control', 'no-cache');
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      }
    },
  });
}

app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) {
    return reply.code(404).send({ error: 'not_found' });
  }
  if (indexHtml && req.method === 'GET') {
    // Client-side routes: /:slug, /admin, /transfers …
    return reply.type('text/html').header('cache-control', 'no-cache').send(indexHtml);
  }
  return reply.code(404).send({ error: 'not_found' });
});

app.setErrorHandler((err, req, reply) => {
  if ((err as { statusCode?: number }).statusCode === 413) {
    return reply.code(413).send({ error: 'payload_too_large' });
  }
  req.log.error({ err }, 'request failed');
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  const code = (err as { code?: string }).code ?? 'error';
  return reply.code(status).send({ error: status === 500 ? 'internal_error' : code });
});

const stopCleanup = startCleanupLoop(app.log);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  stopCleanup();
  try {
    await app.close();
  } catch (err) {
    app.log.error({ err }, 'error closing server');
  }
  closeDb();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: PORT, host: HOST });
  const settings = getSettings();
  app.log.info(
    {
      configDir: CONFIG_DIR,
      dataDir: DATA_DIR,
      masterKey: masterKeySource(),
      adminConfigured: settings.adminPasswordHash !== '',
      webUi: hasBuiltWeb ? WEB_DIST : 'dev server',
    },
    'fling is up',
  );
  if (settings.adminPasswordHash === '') {
    app.log.warn('No admin password set yet — open /admin to create one.');
  }
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
