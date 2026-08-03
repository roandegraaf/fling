import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

// Modules read env at import time, so point them at a scratch dir first.
const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'fling-shrink-test-'));
process.env.FLING_CONFIG_DIR = path.join(scratch, 'config');
process.env.FLING_DATA_DIR = path.join(scratch, 'data');

const { CHUNK_SIZE, sealChunk, openChunk, fileKey } = await import('./crypto.ts');
const { chunkCountFor, blobPath, createDecryptedStream, readStored, writeWholeBlob } =
  await import('./storage.ts');
const { db, q, newBitmap, storedSizeOf } = await import('./db.ts');
const {
  encodeJpegVerified,
  encoderAvailable,
  shrinkFile,
  shrinkStats,
  __setBounds,
  __setEncoderAvailable,
} = await import('./recompress.ts');
const { runCleanup } = await import('./cleanup.ts');

/**
 * A 96x96 synthetic gradient, JPEG-encoded. Generated for this suite rather than
 * taken from anywhere, so the repository stays free of third-party image assets.
 */
const FIXTURE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBAUEBAYFBQUGBgYHCQ4JCQgICRINDQoOFRIWFhUSFBQXGiEcFxgfGRQUHScd' +
  'HyIjJSUlFhwpLCgkKyEkJST/2wBDAQYGBgkICREJCREkGBQYJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk' +
  'JCQkJCQkJCQkJCQkJCT/wAARCABgAGADASIAAhEBAxEB/8QAGgAAAgMBAQAAAAAAAAAAAAAABAUAAgMBB//EACEQAAEEAgID' +
  'AQEAAAAAAAAAAAABAxNhAgQRIRQxQVES/8QAGQEAAgMBAAAAAAAAAAAAAAAAAAQBAgMF/8QAHBEAAgMBAQEBAAAAAAAAAAAA' +
  'AAIBAxMSEQQh/9oADAMBAAIRAxEAPwDyOGiQ0HQEgOtqc/MBhokNBsJIg1I4AYTsNBiNFkZ5+E6hwAwEgGCa9HfHX8K7E5i6' +
  'CiQ0MPHorBROwZgMNEhoOgJAGoZh0JIg+Epk0c2LRvgAVsrGF5NlYzSHK8g+LRrgxz8CG2eQprX5+Gb3eFlr9A8dai3i0NMN' +
  'WjVNShafpNYpEq6tGeWvx8HeWrRjnrUWX6CJqE6sUchGWWvx8KQ0bRcUzDVZ6Ms2uBmrPRg41Rz0tGZQV5NlUb79BjjRl/HC' +
  'jKv+GUqRlvsYsMgzOPCjHXRBa55Nq1NWmE/DZNdOPRdrgKww5Q5z2TA2qwAZa1A7mt76HKtIvwwcY9glwNWI3NejFWBu4x7B' +
  '8mKG0uF5rC8megdxgbqz16MXNehNLhiaxI4z76B1a7HLmvQNlrUNpcYNWA4YcBTKqhZNdU+GrbCku8SCrMG7CqowZx5QF12R' +
  'iw2c65oGq1OphyhTNoMxb6K5t9CsP+m/IscZ9g2TI0zaMVZGUtMZQNgoplr0MYCKxQhFwzmJ89ajDLVod5a9Ga6tGy/QUmoS' +
  'eIaYatDXxU/C2OtRafpKxSBM6/HwMaZ4N8Nfj4bYs8Cz3emy1+GCN9FcmwyMqrZlDl+QDJrkzhoPVk5Aaxb4U4D4aJDQdCSE' +
  '5uo5wAQUVXXoYwkhDYjMW+PR1GKGEFHYaJ2DMBRnj4dRoNhJCV1J4AojkVB0JIQ1DgBhokNB0JISdQ4P/9k=',
  'base64',
);

// The production floor is 32 KiB; the fixture is deliberately far below it.
__setBounds({ min: 256, minSaving: 0.01 });

after(async () => {
  await fsp.rm(scratch, { recursive: true, force: true });
});

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

/** Inserts a transfer + file row and writes the blob, as a finished upload would. */
async function seedFile(bytes: Buffer, name = 'photo.jpg') {
  const transferId = randomUUID();
  const fileId = randomUUID();
  const chunkCount = chunkCountFor(bytes.length, CHUNK_SIZE);

  q.insertTransfer.run({
    id: transferId,
    slug: `s-${transferId.slice(0, 8)}`,
    created_at: Date.now(),
    expires_at: Date.now() + 3_600_000,
    password_hash: null,
    download_limit: null,
    upload_token_hash: 'x',
    total_size: bytes.length,
    file_count: 1,
    sender_ip: null,
  });
  q.markTransferComplete.run(Date.now(), transferId);
  q.insertFile.run({
    id: fileId,
    transfer_id: transferId,
    path: name,
    size: bytes.length,
    chunk_size: CHUNK_SIZE,
    chunk_count: chunkCount,
    received_bitmap: newBitmap(chunkCount),
    complete: 1,
    sort_order: 0,
  });

  await writeWholeBlob(transferId, fileId, null, CHUNK_SIZE, bytes);
  return q.fileById.get(fileId)!;
}

describe('lossless recompression', () => {
  test('the fixture is a real JPEG that round-trips through the codec', async (t) => {
    if (!(await encoderAvailable())) return t.skip('libjxl (cjxl/djxl) not installed');

    const encoded = await encodeJpegVerified(FIXTURE_JPEG);
    assert.ok(encoded, 'expected the fixture to be encodable');
    assert.ok(encoded.length < FIXTURE_JPEG.length, 'encoded form should be smaller');
  });

  test('a shrunk file still downloads byte-for-byte identical', async (t) => {
    if (!(await encoderAvailable())) return t.skip('libjxl not installed');

    const file = await seedFile(FIXTURE_JPEG);
    const outcome = await shrinkFile(file);
    assert.equal(outcome.status, 'shrunk');

    const after = q.fileById.get(file.id)!;
    assert.equal(after.codec, 'jxl');
    assert.equal(after.shrink_state, 'shrunk');
    assert.ok(storedSizeOf(after) < after.size, 'stored form should be smaller than the original');
    // `size` is what a recipient is promised; it must never move.
    assert.equal(after.size, FIXTURE_JPEG.length);

    const served = await collect(createDecryptedStream(after));
    assert.deepEqual(served, FIXTURE_JPEG, 'download must return the sender\'s exact bytes');
  });

  test('a Range request over a shrunk file still slices the original correctly', async (t) => {
    if (!(await encoderAvailable())) return t.skip('libjxl not installed');

    const file = await seedFile(FIXTURE_JPEG);
    assert.equal((await shrinkFile(file)).status, 'shrunk');
    const after = q.fileById.get(file.id)!;

    const slice = await collect(createDecryptedStream(after, 10, 99));
    assert.deepEqual(slice, FIXTURE_JPEG.subarray(10, 100));
  });

  test('the original survives the shrink and is reclaimed only by the sweep', async (t) => {
    if (!(await encoderAvailable())) return t.skip('libjxl not installed');

    const file = await seedFile(FIXTURE_JPEG);
    await shrinkFile(file);
    const after = q.fileById.get(file.id)!;
    assert.equal(after.shrink_state, 'shrunk');

    // Still there on purpose — a request that resolved the pre-shrink row may
    // not have opened its blob yet.
    const original = blobPath(after.transfer_id, after.id, null);
    assert.ok((await fsp.stat(original)).size > 0);
    assert.ok((await fsp.stat(blobPath(after.transfer_id, after.id, 'jxl'))).size > 0);

    // Inside the grace window the sweep must leave it alone.
    __setBounds({ sweepGraceMs: 60 * 60 * 1000 });
    await runCleanup();
    assert.ok((await fsp.stat(original)).size > 0, 'swept too early');
    assert.equal(q.fileById.get(file.id)!.shrink_state, 'shrunk');

    __setBounds({ sweepGraceMs: 0 });
    await runCleanup();
    await assert.rejects(() => fsp.stat(original), 'the superseded blob should be gone');
    assert.equal(q.fileById.get(file.id)!.shrink_state, 'done');
  });

  test('a download that resolved the pre-shrink row still succeeds', async (t) => {
    if (!(await encoderAvailable())) return t.skip('libjxl not installed');

    // Exactly the zip case: the row is captured up front, the blob is opened
    // much later, and a shrink lands in between.
    const stale = await seedFile(FIXTURE_JPEG);
    const stream = createDecryptedStream(stale);

    await shrinkFile(stale);
    assert.equal(q.fileById.get(stale.id)!.codec, 'jxl');

    // The stream has not been consumed yet, so its open happens now — after the
    // row flipped. It must still find the bytes it was promised.
    assert.deepEqual(await collect(stream), FIXTURE_JPEG);
  });

  test('each storage variant uses a distinct key, so a rewrite cannot reuse a nonce', () => {
    const id = randomUUID();
    assert.notDeepEqual(
      fileKey(id, ''),
      fileKey(id, 'jxl'),
      'reusing one key across two plaintexts at nonce 0 would be catastrophic',
    );

    // Concretely: a chunk sealed as one variant must not open as the other.
    const sealed = sealChunk(id, 0, Buffer.from('hello world'), 'jxl');
    assert.throws(() => openChunk(id, 0, sealed, ''));
    assert.deepEqual(openChunk(id, 0, sealed, 'jxl'), Buffer.from('hello world'));
  });

  test('a codec that fails to reconstruct leaves the file untouched', async () => {
    // Pretend the encoder exists but hand it something it cannot transcode.
    const notAJpeg = Buffer.alloc(4096, 0x42);
    const file = await seedFile(notAJpeg, 'fake.jpg');

    const outcome = await shrinkFile(file);
    assert.equal(outcome.status, 'skipped');

    const after = q.fileById.get(file.id)!;
    assert.equal(after.codec, null);
    assert.equal(after.shrink_state, 'skipped');
    assert.deepEqual(await readStored(after), notAJpeg, 'bytes must survive a failed attempt');
  });

  test('ineligible files are skipped without being read', async () => {
    const doc = await seedFile(Buffer.alloc(4096, 7), 'notes.txt');
    assert.deepEqual(await shrinkFile(doc), { status: 'skipped', reason: 'unsupported-type' });

    const tiny = await seedFile(Buffer.alloc(16, 1), 'tiny.jpg');
    assert.deepEqual(await shrinkFile(tiny), { status: 'skipped', reason: 'too-small' });

    for (const f of [doc, tiny]) {
      assert.equal(q.fileById.get(f.id)!.codec, null);
    }
  });

  test('the worker never revisits a file it already settled', async () => {
    const doc = await seedFile(Buffer.alloc(4096, 7), 'skipme.txt');
    await shrinkFile(doc);
    const ids = q.shrinkCandidates.all(100).map((f) => f.id);
    assert.ok(!ids.includes(doc.id), 'a settled file must leave the pending queue');
  });

  test('cleanup reclaims an original left behind by a crash mid-shrink', async (t) => {
    if (!(await encoderAvailable())) return t.skip('libjxl not installed');

    const file = await seedFile(FIXTURE_JPEG);
    await shrinkFile(file);
    const after = q.fileById.get(file.id)!;

    // Simulate crashing after the row flipped but before the sweep ran.
    const stale = blobPath(after.transfer_id, after.id, null);
    await fsp.writeFile(stale, 'left over');
    __setBounds({ sweepGraceMs: 0 });
    await runCleanup();

    await assert.rejects(() => fsp.stat(stale), 'the sweep should have removed it');
    // And the file still serves correctly afterwards.
    assert.deepEqual(await collect(createDecryptedStream(after)), FIXTURE_JPEG);
  });

  test('stats report real savings and never a negative number', async (t) => {
    if (!(await encoderAvailable())) return t.skip('libjxl not installed');

    const before = shrinkStats();
    const file = await seedFile(FIXTURE_JPEG);
    await shrinkFile(file);
    const stats = shrinkStats();

    assert.ok(stats.filesShrunk > before.filesShrunk);
    assert.ok(stats.savedBytes > 0);
    assert.ok(stats.storedBytes < stats.logicalBytes);
    assert.ok(stats.savedPercent > 0 && stats.savedPercent < 100);
  });

  test('with no encoder installed the feature is inert rather than lossy', async () => {
    __setEncoderAvailable(false);
    try {
      const file = await seedFile(FIXTURE_JPEG, 'untouched.jpg');
      const outcome = await shrinkFile(file);
      assert.equal(outcome.status, 'skipped');
      assert.deepEqual(await readStored(q.fileById.get(file.id)!), FIXTURE_JPEG);
    } finally {
      __setEncoderAvailable(null);
    }
  });
});
