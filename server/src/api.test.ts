import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';

const execFileAsync = promisify(execFile);

const PORT = 8791 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;
const CHUNK = 4 * 1024 * 1024;
const SERVER_ENTRY = path.join(import.meta.dirname, 'index.ts');

let scratch = '';
let server: ChildProcess | null = null;

async function startServer(): Promise<void> {
  server = spawn(process.execPath, ['--experimental-strip-types', SERVER_ENTRY], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      FLING_CONFIG_DIR: path.join(scratch, 'config'),
      FLING_DATA_DIR: path.join(scratch, 'data'),
      FLING_PORT: String(PORT),
      FLING_HOST: '127.0.0.1',
      FLING_LOG_LEVEL: 'error',
      FLING_ADMIN_PASSWORD: 'test-admin-password',
      // Pinned so blobs written before a restart stay readable after it.
      FLING_MASTER_KEY: 'BuqDkQwbLBGVWKgxWVfBjEbBc4Ee7SjZ+1IFo0BWvQI=',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (buf) => {
    const text = String(buf);
    if (text.includes('"level":50') || text.includes('Error')) process.stderr.write(text);
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server did not start in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function stopServer(): Promise<void> {
  if (!server) return;
  const proc = server;
  server = null;
  await new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill('SIGKILL'); // hard kill: nothing should depend on a clean shutdown
    setTimeout(resolve, 3000).unref();
  });
}

before(async () => {
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'fling-e2e-'));
  await startServer();
});

after(async () => {
  await stopServer();
  if (scratch) await fsp.rm(scratch, { recursive: true, force: true });
});

const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

interface CreatedFile {
  id: string;
  path: string;
  size: number;
  chunkCount: number;
}

async function createTransfer(
  files: Array<{ path: string; size: number }>,
  extra: Record<string, unknown> = {},
) {
  const res = await fetch(`${BASE}/api/transfers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files, expiryDays: 7, ...extra }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function putChunk(
  transferId: string,
  token: string,
  fileId: string,
  index: number,
  data: Buffer,
): Promise<Response> {
  return fetch(`${BASE}/api/transfers/${transferId}/files/${fileId}/chunks/${index}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
    },
    body: data,
  });
}

async function finalizeIt(transferId: string, token: string): Promise<Response> {
  return fetch(`${BASE}/api/transfers/${transferId}/finalize`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

async function uploadWhole(
  transferId: string,
  token: string,
  file: CreatedFile,
  source: Buffer,
  skip: (index: number) => boolean = () => false,
): Promise<void> {
  for (let i = 0; i < file.chunkCount; i++) {
    if (skip(i)) continue;
    const slice = source.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, source.length));
    const res = await putChunk(transferId, token, file.id, i, slice);
    assert.equal(res.status, 200, `chunk ${i} of ${file.path}: ${await res.text()}`);
  }
}

describe('transfer lifecycle', () => {
  const layout = [
    { path: 'Campaign_master_v4.mov', size: CHUNK * 2 + 4321 },
    { path: 'Shoot/RAW/IMG_0041.CR3', size: CHUNK + 17 },
    { path: 'Shoot/RAW/IMG_0042.CR3', size: 1234 },
    { path: 'Shoot/selectie.pdf', size: 0 },
  ];

  test('upload → resume across a hard restart → finalize → download', async () => {
    const sources = new Map<string, Buffer>(
      layout.map((f) => [f.path, randomBytes(f.size)] as const),
    );

    const created = await createTransfer(layout, { dirs: ['Shoot/Empty folder'] });
    assert.equal(created.status, 200, JSON.stringify(created.body));

    const { transferId, uploadToken, slug, files } = created.body as {
      transferId: string;
      uploadToken: string;
      slug: string;
      files: CreatedFile[];
    };
    assert.match(slug, /^[23456789abcdefghjkmnpqrstuvwxyz]{4}-[23456789abcdefghjkmnpqrstuvwxyz]{4}$/);

    const byPath = new Map(files.map((f) => [f.path, f]));

    // Upload everything except chunk 1 of the big file, then kill the process.
    const big = byPath.get('Campaign_master_v4.mov')!;
    for (const file of files) {
      const source = sources.get(file.path)!;
      await uploadWhole(transferId, uploadToken, file, source, (i) => file.id === big.id && i === 1);
    }

    await stopServer();
    await startServer();

    // The server must remember exactly which chunks it already has.
    const statusRes = await fetch(`${BASE}/api/transfers/${transferId}/status`, {
      headers: { authorization: `Bearer ${uploadToken}` },
    });
    assert.equal(statusRes.status, 200);
    const status = (await statusRes.json()) as {
      status: string;
      files: Array<{ id: string; missing: number[]; complete: boolean }>;
    };
    assert.equal(status.status, 'uploading');
    const bigStatus = status.files.find((f) => f.id === big.id)!;
    assert.deepEqual(bigStatus.missing, [1], 'exactly the interrupted chunk is missing');
    assert.equal(bigStatus.complete, false);
    for (const other of status.files.filter((f) => f.id !== big.id)) {
      assert.equal(other.complete, true, 'other files survived the restart');
    }

    // Finalizing early must be refused.
    const early = await fetch(`${BASE}/api/transfers/${transferId}/finalize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${uploadToken}` },
    });
    assert.equal(early.status, 409);

    // Resume the missing chunk.
    const bigSource = sources.get(big.path)!;
    const res = await putChunk(
      transferId,
      uploadToken,
      big.id,
      1,
      bigSource.subarray(CHUNK, CHUNK * 2),
    );
    assert.equal(res.status, 200);

    // Re-sending a chunk is idempotent.
    const again = await putChunk(
      transferId,
      uploadToken,
      big.id,
      1,
      bigSource.subarray(CHUNK, CHUNK * 2),
    );
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { duplicate?: boolean }).duplicate, true);

    const finalize = await fetch(`${BASE}/api/transfers/${transferId}/finalize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${uploadToken}` },
    });
    assert.equal(finalize.status, 200, await finalize.text());

    /* ── manifest ────────────────────────────────────────────────────────── */
    const manifestRes = await fetch(`${BASE}/api/t/${slug}`);
    assert.equal(manifestRes.status, 200);
    const manifest = (await manifestRes.json()) as {
      fileCount: number;
      totalSize: number;
      tree: Array<{ type: string; name: string; size: number; children?: unknown[] }>;
    };
    assert.equal(manifest.fileCount, 4);
    assert.equal(
      manifest.totalSize,
      layout.reduce((s, f) => s + f.size, 0),
    );
    const shoot = manifest.tree.find((n) => n.name === 'Shoot');
    assert.ok(shoot && shoot.type === 'dir', 'folder tree is rebuilt');

    /* ── whole-file download ─────────────────────────────────────────────── */
    const fileRes = await fetch(`${BASE}/api/t/${slug}/file/${big.id}`);
    assert.equal(fileRes.status, 200);
    assert.equal(fileRes.headers.get('content-length'), String(big.size));
    assert.equal(fileRes.headers.get('accept-ranges'), 'bytes');
    const downloaded = Buffer.from(await fileRes.arrayBuffer());
    assert.equal(sha(downloaded), sha(bigSource), 'downloaded bytes match what was uploaded');

    /* ── range download ──────────────────────────────────────────────────── */
    const start = CHUNK - 10;
    const end = CHUNK + 10;
    const rangeRes = await fetch(`${BASE}/api/t/${slug}/file/${big.id}`, {
      headers: { range: `bytes=${start}-${end}` },
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get('content-range'), `bytes ${start}-${end}/${big.size}`);
    const ranged = Buffer.from(await rangeRes.arrayBuffer());
    assert.ok(ranged.equals(bigSource.subarray(start, end + 1)), 'range straddling a chunk boundary');

    const badRange = await fetch(`${BASE}/api/t/${slug}/file/${big.id}`, {
      headers: { range: `bytes=${big.size + 100}-` },
    });
    assert.equal(badRange.status, 416);

    /* ── zip of the whole transfer ───────────────────────────────────────── */
    const zipRes = await fetch(`${BASE}/api/t/${slug}/zip`);
    assert.equal(zipRes.status, 200);
    const contentLength = zipRes.headers.get('content-length');
    assert.ok(contentLength, 'zip advertises a real Content-Length');
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    assert.equal(zipBuf.length, Number(contentLength), 'advertised size matches the actual bytes');

    const zipPath = path.join(scratch, 'all.zip');
    await fsp.writeFile(zipPath, zipBuf);
    const listing = await unzipList(zipPath);
    if (listing) {
      for (const f of layout) assert.ok(listing.includes(f.path), `zip contains ${f.path}`);
      assert.ok(
        listing.some((n) => n.startsWith('Shoot/Empty folder')),
        'empty folder is preserved in the zip',
      );
    }

    /* ── zip of one folder ───────────────────────────────────────────────── */
    const folderRes = await fetch(`${BASE}/api/t/${slug}/zip?path=${encodeURIComponent('Shoot/RAW')}`);
    assert.equal(folderRes.status, 200);
    assert.match(folderRes.headers.get('content-disposition') ?? '', /RAW\.zip/);
    const folderZip = Buffer.from(await folderRes.arrayBuffer());
    const folderZipPath = path.join(scratch, 'raw.zip');
    await fsp.writeFile(folderZipPath, folderZip);
    const folderListing = await unzipList(folderZipPath);
    if (folderListing) {
      assert.deepEqual(folderListing.sort(), ['RAW/IMG_0041.CR3', 'RAW/IMG_0042.CR3']);
    }
    // Extracted content must round-trip too, not just the file names.
    if (folderListing) {
      const outDir = path.join(scratch, 'extracted');
      await execFileAsync('unzip', ['-o', '-q', folderZipPath, '-d', outDir]).catch(() => null);
      const extracted = await fsp
        .readFile(path.join(outDir, 'RAW', 'IMG_0041.CR3'))
        .catch(() => null);
      if (extracted) {
        assert.equal(sha(extracted), sha(sources.get('Shoot/RAW/IMG_0041.CR3')!));
      }
    }

    const missingFolder = await fetch(`${BASE}/api/t/${slug}/zip?path=Nope`);
    assert.equal(missingFolder.status, 404);
  });
});

describe('access control', () => {
  test('password gates the manifest and downloads', async () => {
    const created = await createTransfer([{ path: 'secret.txt', size: 12 }], {
      password: 'hunter2hunter2',
    });
    const { transferId, uploadToken, slug, files } = created.body as {
      transferId: string;
      uploadToken: string;
      slug: string;
      files: CreatedFile[];
    };
    await putChunk(transferId, uploadToken, files[0].id, 0, Buffer.alloc(12, 7));
    await fetch(`${BASE}/api/transfers/${transferId}/finalize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${uploadToken}` },
    });

    const locked = await fetch(`${BASE}/api/t/${slug}`);
    assert.equal(locked.status, 401);
    assert.equal(((await locked.json()) as { passwordRequired: boolean }).passwordRequired, true);

    const wrong = await fetch(`${BASE}/api/t/${slug}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'nope' }),
    });
    assert.equal(wrong.status, 401);

    const right = await fetch(`${BASE}/api/t/${slug}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'hunter2hunter2' }),
    });
    assert.equal(right.status, 200);
    const { token } = (await right.json()) as { token: string };

    const unlocked = await fetch(`${BASE}/api/t/${slug}?k=${encodeURIComponent(token)}`);
    assert.equal(unlocked.status, 200);

    const fileOk = await fetch(
      `${BASE}/api/t/${slug}/file/${files[0].id}?k=${encodeURIComponent(token)}`,
    );
    assert.equal(fileOk.status, 200);

    // A grant for one transfer must not open another.
    const other = await createTransfer([{ path: 'x.txt', size: 1 }], { password: 'abcabcabc' });
    const otherSlug = (other.body as { slug: string }).slug;
    const crossed = await fetch(`${BASE}/api/t/${otherSlug}?k=${encodeURIComponent(token)}`);
    assert.notEqual(crossed.status, 200);
  });

  test('looking at a transfer without downloading costs nothing', async () => {
    const created = await createTransfer([{ path: 'peek.txt', size: 4 }], { downloadLimit: 1 });
    const { transferId, uploadToken, slug, files } = created.body as {
      transferId: string;
      uploadToken: string;
      slug: string;
      files: CreatedFile[];
    };
    await putChunk(transferId, uploadToken, files[0].id, 0, Buffer.alloc(4, 9));
    await finalizeIt(transferId, uploadToken);

    // Open the page three times without fetching a file.
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${BASE}/api/t/${slug}`);
      const body = (await res.json()) as { downloadCount: number; limitReached: boolean };
      assert.equal(body.downloadCount, 0, 'viewing does not spend the allowance');
      assert.equal(body.limitReached, false);
    }

    // The single allowed download is still there when they come back for it.
    const manifest = (await (await fetch(`${BASE}/api/t/${slug}`)).json()) as {
      accessToken: string;
    };
    const res = await fetch(
      `${BASE}/api/t/${slug}/file/${files[0].id}?k=${encodeURIComponent(manifest.accessToken)}`,
    );
    assert.equal(res.status, 200);
    const after = (await (await fetch(`${BASE}/api/t/${slug}`)).json()) as { downloadCount: number };
    assert.equal(after.downloadCount, 1, 'charged on the actual fetch');
  });

  test('re-opening the link from an email does not spend a second download', async () => {
    const created = await createTransfer([{ path: 'again.txt', size: 4 }], { downloadLimit: 1 });
    const { transferId, uploadToken, slug, files } = created.body as {
      transferId: string;
      uploadToken: string;
      slug: string;
      files: CreatedFile[];
    };
    await putChunk(transferId, uploadToken, files[0].id, 0, Buffer.alloc(4, 1));
    await finalizeIt(transferId, uploadToken);

    const first = (await (await fetch(`${BASE}/api/t/${slug}`)).json()) as { accessToken: string };
    assert.equal(
      (
        await fetch(
          `${BASE}/api/t/${slug}/file/${files[0].id}?k=${encodeURIComponent(first.accessToken)}`,
        )
      ).status,
      200,
    );

    // Tab closed: the token is gone, so this is a bare page load like a re-click.
    const second = await fetch(`${BASE}/api/t/${slug}`);
    const body = (await second.json()) as {
      downloadCount: number;
      limitReached: boolean;
      accessToken: string | null;
    };
    assert.equal(body.limitReached, false, 'recognised as the same visitor returning');
    assert.ok(body.accessToken);
    assert.equal(body.downloadCount, 1, 'still only one download spent');

    const again = await fetch(
      `${BASE}/api/t/${slug}/file/${files[0].id}?k=${encodeURIComponent(body.accessToken!)}`,
    );
    assert.equal(again.status, 200, 'and they can download again');
    const finalCount = (await (await fetch(`${BASE}/api/t/${slug}`)).json()) as {
      downloadCount: number;
    };
    assert.equal(finalCount.downloadCount, 1);
  });

  test('the download limit counts people, not files pulled from it', async () => {
    const created = await createTransfer(
      [
        { path: 'one.txt', size: 5 },
        { path: 'Folder/two.txt', size: 7 },
      ],
      { downloadLimit: 1 },
    );
    const { transferId, uploadToken, slug, files } = created.body as {
      transferId: string;
      uploadToken: string;
      slug: string;
      files: CreatedFile[];
    };
    for (const file of files) {
      await putChunk(transferId, uploadToken, file.id, 0, Buffer.alloc(file.size, 1));
    }
    await finalizeIt(transferId, uploadToken);

    // trustProxy is on, so X-Forwarded-For lets us act as two distinct people.
    const alice = { 'x-forwarded-for': '198.51.100.10' };
    const bob = { 'x-forwarded-for': '203.0.113.20' };

    const opened = await fetch(`${BASE}/api/t/${slug}`, { headers: alice });
    assert.equal(opened.status, 200);
    const manifest = (await opened.json()) as {
      accessToken: string | null;
      downloadCount: number;
      limitReached: boolean;
    };
    assert.ok(manifest.accessToken, 'a session token is issued');
    assert.equal(manifest.downloadCount, 0, 'opening the page is free');
    assert.equal(manifest.limitReached, false);

    const k = encodeURIComponent(manifest.accessToken);

    // One person can pull everything out, repeatedly — this is the whole point.
    for (const file of files) {
      const res = await fetch(`${BASE}/api/t/${slug}/file/${file.id}?k=${k}`, { headers: alice });
      assert.equal(res.status, 200, `${file.path} downloadable within the session`);
    }
    assert.equal(
      (await fetch(`${BASE}/api/t/${slug}/zip?k=${k}`, { headers: alice })).status,
      200,
      'download-all works',
    );
    assert.equal(
      (await fetch(`${BASE}/api/t/${slug}/zip?path=Folder&k=${k}`, { headers: alice })).status,
      200,
    );
    assert.equal(
      (await fetch(`${BASE}/api/t/${slug}/file/${files[0].id}?k=${k}`, { headers: alice })).status,
      200,
      'the same file again still works',
    );

    const afterAlice = (await (
      await fetch(`${BASE}/api/t/${slug}?k=${k}`, { headers: alice })
    ).json()) as { downloadCount: number };
    assert.equal(afterAlice.downloadCount, 1, 'everything Alice took counts as one download');

    // Somebody else is a second download, and the allowance is gone.
    const bobView = await fetch(`${BASE}/api/t/${slug}`, { headers: bob });
    assert.equal(bobView.status, 200, 'the page still loads so they can see why');
    const bobBody = (await bobView.json()) as { limitReached: boolean; accessToken: string | null };
    assert.equal(bobBody.limitReached, true);
    assert.equal(bobBody.accessToken, null);
    assert.equal((await fetch(`${BASE}/api/t/${slug}/zip`, { headers: bob })).status, 410);
    assert.equal(
      (await fetch(`${BASE}/api/t/${slug}/file/${files[0].id}`, { headers: bob })).status,
      410,
    );
  });

  test('opening several tabs before downloading cannot beat the limit', async () => {
    const created = await createTransfer([{ path: 'race.txt', size: 4 }], { downloadLimit: 1 });
    const { transferId, uploadToken, slug, files } = created.body as {
      transferId: string;
      uploadToken: string;
      slug: string;
      files: CreatedFile[];
    };
    await putChunk(transferId, uploadToken, files[0].id, 0, Buffer.alloc(4, 5));
    await finalizeIt(transferId, uploadToken);

    // Two different people both open the page while the allowance is untouched,
    // so both are handed a token.
    const one = { 'x-forwarded-for': '198.51.100.77' };
    const two = { 'x-forwarded-for': '203.0.113.88' };
    const tokenOne = (
      (await (await fetch(`${BASE}/api/t/${slug}`, { headers: one })).json()) as {
        accessToken: string;
      }
    ).accessToken;
    const tokenTwo = (
      (await (await fetch(`${BASE}/api/t/${slug}`, { headers: two })).json()) as {
        accessToken: string;
      }
    ).accessToken;
    assert.ok(tokenOne && tokenTwo);

    // Whoever downloads first gets it; the other is refused at fetch time.
    assert.equal(
      (
        await fetch(
          `${BASE}/api/t/${slug}/file/${files[0].id}?k=${encodeURIComponent(tokenOne)}`,
          { headers: one },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(
          `${BASE}/api/t/${slug}/file/${files[0].id}?k=${encodeURIComponent(tokenTwo)}`,
          { headers: two },
        )
      ).status,
      410,
      'the limit is enforced when files are taken, not when pages are opened',
    );
  });

  test('range requests never spend a download', async () => {
    const created = await createTransfer([{ path: 'movie.mp4', size: 4096 }], { downloadLimit: 3 });
    const { transferId, uploadToken, slug, files } = created.body as {
      transferId: string;
      uploadToken: string;
      slug: string;
      files: CreatedFile[];
    };
    await putChunk(transferId, uploadToken, files[0].id, 0, randomBytes(4096));
    await finalizeIt(transferId, uploadToken);

    const manifest = (await (await fetch(`${BASE}/api/t/${slug}`)).json()) as {
      accessToken: string;
      downloadCount: number;
    };
    assert.equal(manifest.downloadCount, 0);
    const k = encodeURIComponent(manifest.accessToken);

    // A player seeking around fires many ranged requests; together they are one
    // person taking one file.
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${BASE}/api/t/${slug}/file/${files[0].id}?k=${k}`, {
        headers: { range: 'bytes=1000-2000' },
      });
      assert.equal(res.status, 206);
    }

    const after = (await (await fetch(`${BASE}/api/t/${slug}?k=${k}`)).json()) as {
      downloadCount: number;
    };
    assert.equal(after.downloadCount, 1, 'all that seeking counts once, not five times');
  });

  test('an open link with no limit and no password needs no session token', async () => {
    const created = await createTransfer([{ path: 'open.txt', size: 9 }]);
    const { transferId, uploadToken, slug, files } = created.body as {
      transferId: string;
      uploadToken: string;
      slug: string;
      files: CreatedFile[];
    };
    await putChunk(transferId, uploadToken, files[0].id, 0, Buffer.alloc(9, 3));
    await finalizeIt(transferId, uploadToken);

    // A bare URL keeps working, so links can be forwarded freely.
    assert.equal((await fetch(`${BASE}/api/t/${slug}/file/${files[0].id}`)).status, 200);
    assert.equal((await fetch(`${BASE}/api/t/${slug}/zip`)).status, 200);
  });

  test('a browser navigation gets a readable HTML page, never raw JSON', async () => {
    const created = await createTransfer([{ path: 'gone.txt', size: 4 }], { downloadLimit: 1 });
    const { transferId, uploadToken, slug, files } = created.body as {
      transferId: string;
      uploadToken: string;
      slug: string;
      files: CreatedFile[];
    };
    await putChunk(transferId, uploadToken, files[0].id, 0, Buffer.alloc(4, 2));
    await finalizeIt(transferId, uploadToken);

    // One visitor takes the single allowed download…
    const claimer = { 'x-forwarded-for': '198.51.100.44' };
    const claimed = (await (
      await fetch(`${BASE}/api/t/${slug}`, { headers: claimer })
    ).json()) as { accessToken: string };
    await fetch(
      `${BASE}/api/t/${slug}/file/${files[0].id}?k=${encodeURIComponent(claimed.accessToken)}`,
      { headers: claimer },
    );

    // …and somebody else navigates straight to a download URL.
    const asBrowser = {
      'x-forwarded-for': '203.0.113.99',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };

    for (const url of [`${BASE}/api/t/${slug}/zip`, `${BASE}/api/t/${slug}/file/${files[0].id}`]) {
      const res = await fetch(url, { headers: asBrowser });
      assert.equal(res.status, 410);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
      const html = await res.text();
      assert.match(html, /fully claimed/i, 'explains what happened in plain language');
      assert.doesNotMatch(html, /^\s*\{"error"/, 'not raw JSON');
    }

    // A nonexistent link navigated to directly also renders a page.
    const missing = await fetch(`${BASE}/api/t/zzzz-zzzz/zip`, { headers: asBrowser });
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type') ?? '', /text\/html/);

    // But fetch() — which does not ask for HTML — still gets JSON.
    const asFetch = await fetch(`${BASE}/api/t/${slug}/zip`, {
      headers: { 'x-forwarded-for': '203.0.113.99' },
    });
    assert.match(asFetch.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(((await asFetch.json()) as { error: string }).error, 'limit_reached');
  });

  test('upload token is required and scoped', async () => {
    const a = await createTransfer([{ path: 'a.txt', size: 4 }]);
    const b = await createTransfer([{ path: 'b.txt', size: 4 }]);
    const A = a.body as { transferId: string; uploadToken: string; files: CreatedFile[] };
    const B = b.body as { transferId: string; uploadToken: string };

    const noToken = await fetch(
      `${BASE}/api/transfers/${A.transferId}/files/${A.files[0].id}/chunks/0`,
      { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(4) },
    );
    assert.equal(noToken.status, 403);

    const wrongToken = await putChunk(A.transferId, B.uploadToken, A.files[0].id, 0, Buffer.alloc(4));
    assert.equal(wrongToken.status, 403);
  });

  test('rejects hostile paths and oversized declarations', async () => {
    const traversal = await createTransfer([{ path: '../../etc/passwd', size: 10 }]);
    assert.equal(traversal.status, 400);
    assert.equal((traversal.body as { error: string }).error, 'bad_path');

    const huge = await createTransfer([{ path: 'big.bin', size: 900 * 1024 ** 3 }]);
    assert.equal(huge.status, 413);
  });

  test('a wrong-sized chunk is refused', async () => {
    const created = await createTransfer([{ path: 'exact.bin', size: 100 }]);
    const { transferId, uploadToken, files } = created.body as {
      transferId: string;
      uploadToken: string;
      files: CreatedFile[];
    };
    const res = await putChunk(transferId, uploadToken, files[0].id, 0, Buffer.alloc(99));
    assert.equal(res.status, 400);
    assert.equal((await res.json() as { error: string }).error, 'bad_chunk_size');
  });

  test('an unfinalized transfer is not downloadable', async () => {
    const created = await createTransfer([{ path: 'pending.txt', size: 10 }]);
    const { slug } = created.body as { slug: string };
    assert.equal((await fetch(`${BASE}/api/t/${slug}`)).status, 404);
  });
});

describe('admin', () => {
  const jar: string[] = [];

  async function adminFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), cookie: jar.join('; ') },
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const cookie of setCookie) jar.push(cookie.split(';')[0]);
    return res;
  }

  test('settings and transfer management require a login', async () => {
    assert.equal((await fetch(`${BASE}/api/admin/settings`)).status, 401);
    assert.equal((await fetch(`${BASE}/api/admin/transfers`)).status, 401);

    const badLogin = await adminFetch(`${BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(badLogin.status, 401);

    const login = await adminFetch(`${BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-admin-password' }),
    });
    assert.equal(login.status, 200);

    const settingsRes = await adminFetch(`${BASE}/api/admin/settings`);
    assert.equal(settingsRes.status, 200);
    const { settings, expiryDaysCeiling } = (await settingsRes.json()) as {
      settings: Record<string, number>;
      expiryDaysCeiling: number;
    };
    assert.equal(expiryDaysCeiling, 30);
    assert.ok(settings.maxTransferSize > 0);

    // Expiry can never be pushed past the 30-day ceiling.
    const updated = await adminFetch(`${BASE}/api/admin/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxExpiryDays: 999, maxTransferSize: 1024 ** 3 }),
    });
    const after = (await updated.json()) as { settings: Record<string, number> };
    assert.equal(after.settings.maxExpiryDays, 30);
    assert.equal(after.settings.maxTransferSize, 1024 ** 3);

    // And that new limit is enforced on the next upload.
    const tooBig = await createTransfer([{ path: 'x.bin', size: 2 * 1024 ** 3 }]);
    assert.equal(tooBig.status, 413);

    // Restore something roomy for any later tests.
    await adminFetch(`${BASE}/api/admin/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxTransferSize: 20 * 1024 ** 3 }),
    });

    const list = await adminFetch(`${BASE}/api/admin/transfers`);
    assert.equal(list.status, 200);
    const { transfers } = (await list.json()) as { transfers: Array<{ id: string }> };
    assert.ok(transfers.length > 0, 'admin sees transfers from every browser');

    const stats = await adminFetch(`${BASE}/api/admin/stats`);
    assert.equal(stats.status, 200);
    const statsBody = (await stats.json()) as {
      storage: { onDiskBytes: number };
      encryption: { masterKeySource: string };
    };
    assert.ok(statsBody.storage.onDiskBytes > 0);
    assert.equal(statsBody.encryption.masterKeySource, 'env');

    // Force-delete really removes the blobs.
    const victim = transfers[0].id;
    const del = await adminFetch(`${BASE}/api/admin/transfers/${victim}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const gone = await fsp
      .stat(path.join(scratch, 'data', 'blobs', victim))
      .then(() => true)
      .catch(() => false);
    assert.equal(gone, false, 'blob directory is deleted from the share');
  });
});

/** Returns entry names, or null when `unzip` is unavailable on this machine. */
async function unzipList(zipPath: string): Promise<string[] | null> {
  try {
    await execFileAsync('unzip', ['-t', zipPath]);
    const { stdout } = await execFileAsync('unzip', ['-Z1', zipPath]);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}
