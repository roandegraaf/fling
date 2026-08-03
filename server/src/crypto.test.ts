import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

// The modules read env at import time, so point them at a scratch dir first.
const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'fling-test-'));
process.env.FLING_CONFIG_DIR = path.join(scratch, 'config');
process.env.FLING_DATA_DIR = path.join(scratch, 'data');

const { CHUNK_SIZE, TAG_LEN, openChunk, sealChunk, hashPassword, verifyPassword, signGrant, verifyGrant } =
  await import('./crypto.ts');
const { allocateBlob, createDecryptedStream, writeChunk, chunkCountFor, sealedLength } =
  await import('./storage.ts');
const { sanitizeRelPath } = await import('./paths.ts');
const { buildTree } = await import('./tree.ts');
const { newBitmap, hasBit, setBit, missingChunks } = await import('./db.ts');

after(async () => {
  await fsp.rm(scratch, { recursive: true, force: true });
});

function fakeFileRow(id: string, transferId: string, size: number) {
  return {
    id,
    transfer_id: transferId,
    path: 'test.bin',
    size,
    chunk_size: CHUNK_SIZE,
    chunk_count: chunkCountFor(size, CHUNK_SIZE),
    received_bitmap: newBitmap(chunkCountFor(size, CHUNK_SIZE)),
    received_count: 0,
    complete: 1,
    sort_order: 0,
  };
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

describe('chunk sealing', () => {
  test('round-trips', () => {
    const fileId = randomUUID();
    const plain = randomBytes(1024);
    const sealed = sealChunk(fileId, 7, plain);
    assert.equal(sealed.length, plain.length + TAG_LEN);
    assert.deepEqual(openChunk(fileId, 7, sealed), plain);
  });

  test('rejects a chunk decrypted at the wrong index', () => {
    const fileId = randomUUID();
    const sealed = sealChunk(fileId, 3, randomBytes(256));
    assert.throws(() => openChunk(fileId, 4, sealed));
  });

  test('rejects a chunk moved to a different file', () => {
    const sealed = sealChunk(randomUUID(), 0, randomBytes(256));
    assert.throws(() => openChunk(randomUUID(), 0, sealed));
  });

  test('rejects tampered ciphertext', () => {
    const fileId = randomUUID();
    const sealed = sealChunk(fileId, 0, randomBytes(256));
    sealed[10] ^= 0xff;
    assert.throws(() => openChunk(fileId, 0, sealed));
  });
});

describe('blob storage', () => {
  test('writes chunks out of order and reads the file back byte-exact', async () => {
    const transferId = randomUUID();
    const fileId = randomUUID();
    // Two full chunks plus a partial one — exercises the last-chunk maths.
    const size = CHUNK_SIZE * 2 + 12345;
    const source = randomBytes(size);
    const file = fakeFileRow(fileId, transferId, size);

    await allocateBlob(transferId, fileId, size, CHUNK_SIZE);

    // Deliberately reversed: chunks must be position-independent.
    for (let i = file.chunk_count - 1; i >= 0; i--) {
      const slice = source.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, size));
      await writeChunk(transferId, fileId, i, CHUNK_SIZE, size, slice);
    }

    const readBack = await collect(createDecryptedStream(file));
    assert.equal(readBack.length, size);
    assert.ok(readBack.equals(source), 'full read must be byte-exact');
  });

  test('range reads return exactly the requested window', async () => {
    const transferId = randomUUID();
    const fileId = randomUUID();
    const size = CHUNK_SIZE * 2 + 999;
    const source = randomBytes(size);
    const file = fakeFileRow(fileId, transferId, size);

    await allocateBlob(transferId, fileId, size, CHUNK_SIZE);
    for (let i = 0; i < file.chunk_count; i++) {
      await writeChunk(
        transferId,
        fileId,
        i,
        CHUNK_SIZE,
        size,
        source.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, size)),
      );
    }

    const windows: Array<[number, number]> = [
      [0, 0], // single byte
      [0, 99],
      [CHUNK_SIZE - 1, CHUNK_SIZE], // straddles a chunk boundary
      [CHUNK_SIZE + 5, CHUNK_SIZE * 2 + 5], // spans three chunks
      [size - 1, size - 1], // last byte
      [size - 500, size - 1], // tail
      [12345, 2 * CHUNK_SIZE], // arbitrary
    ];

    for (const [start, end] of windows) {
      const got = await collect(createDecryptedStream(file, start, end));
      const want = source.subarray(start, end + 1);
      assert.equal(got.length, want.length, `length for range ${start}-${end}`);
      assert.ok(got.equals(want), `bytes for range ${start}-${end}`);
    }
  });

  test('handles a zero-byte file', async () => {
    const transferId = randomUUID();
    const fileId = randomUUID();
    const file = fakeFileRow(fileId, transferId, 0);
    assert.equal(file.chunk_count, 0);
    await allocateBlob(transferId, fileId, 0, CHUNK_SIZE);
    assert.equal((await collect(createDecryptedStream(file))).length, 0);
  });

  test('on-disk length accounts for one tag per chunk', () => {
    assert.equal(sealedLength(0, CHUNK_SIZE), 0);
    assert.equal(sealedLength(10, CHUNK_SIZE), 10 + TAG_LEN);
    assert.equal(sealedLength(CHUNK_SIZE, CHUNK_SIZE), CHUNK_SIZE + TAG_LEN);
    assert.equal(sealedLength(CHUNK_SIZE + 1, CHUNK_SIZE), CHUNK_SIZE + 1 + TAG_LEN * 2);
  });
});

describe('chunk bitmap', () => {
  test('tracks arbitrary indices', () => {
    const bitmap = newBitmap(20);
    assert.equal(bitmap.length, 3);
    assert.equal(hasBit(bitmap, 0), false);
    assert.equal(setBit(bitmap, 0), true);
    assert.equal(setBit(bitmap, 0), false, 'setting twice reports no change');
    assert.equal(hasBit(bitmap, 0), true);

    setBit(bitmap, 19);
    assert.equal(hasBit(bitmap, 19), true);
    assert.deepEqual(missingChunks(bitmap, 20).slice(0, 3), [1, 2, 3]);
    assert.equal(missingChunks(bitmap, 20).length, 18);
  });
});

describe('path sanitising', () => {
  test('accepts ordinary relative paths', () => {
    assert.equal(sanitizeRelPath('a/b/c.txt'), 'a/b/c.txt');
    assert.equal(sanitizeRelPath('/leading/slash.txt'), 'leading/slash.txt');
    assert.equal(sanitizeRelPath('back\\slash.txt'), 'back/slash.txt');
    assert.equal(sanitizeRelPath('./dot/./file.txt'), 'dot/file.txt');
    assert.equal(sanitizeRelPath('Ünïcøde ✨.png'), 'Ünïcøde ✨.png');
  });

  test('rejects traversal and other hostile shapes', () => {
    for (const bad of [
      '../etc/passwd',
      'a/../../b',
      'C:\\Windows\\system32',
      '//server/share',
      'nul\u0000byte',
      'bell\u0007',
      '',
      '   ',
      '.',
      '..',
      null,
      42,
    ]) {
      assert.equal(sanitizeRelPath(bad as unknown), null, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('tree building', () => {
  test('nests folders and rolls sizes up', () => {
    const rows = [
      { path: 'top.txt', size: 10 },
      { path: 'Shoot/selectie.pdf', size: 20 },
      { path: 'Shoot/RAW/a.cr3', size: 30 },
      { path: 'Shoot/RAW/b.cr3', size: 40 },
    ].map((r, i) => ({ ...fakeFileRow(`f${i}`, 't', r.size), path: r.path }));

    const tree = buildTree(rows, ['Shoot/Empty']);

    // Folders sort before files.
    assert.equal(tree[0].type, 'dir');
    assert.equal(tree[0].name, 'Shoot');
    assert.equal(tree[1].name, 'top.txt');

    const shoot = tree[0];
    assert.equal(shoot.type === 'dir' && shoot.size, 90);
    assert.equal(shoot.type === 'dir' && shoot.fileCount, 3);

    const raw = shoot.type === 'dir' ? shoot.children.find((c) => c.name === 'RAW') : undefined;
    assert.ok(raw && raw.type === 'dir');
    assert.equal(raw.size, 70);
    assert.equal(raw.children.length, 2);

    const empty = shoot.type === 'dir' ? shoot.children.find((c) => c.name === 'Empty') : undefined;
    assert.ok(empty && empty.type === 'dir', 'empty folders survive');
    assert.equal(empty.children.length, 0);
  });
});

describe('passwords and grants', () => {
  test('verifies the right password only', () => {
    const hash = hashPassword('correct horse battery staple');
    assert.equal(verifyPassword('correct horse battery staple', hash), true);
    assert.equal(verifyPassword('wrong', hash), false);
    assert.equal(verifyPassword('', hash), false);
  });

  test('grants are scoped and expire', () => {
    const token = signGrant('dl:abcd-efgh', 60_000);
    assert.equal(verifyGrant('dl:abcd-efgh', token), true);
    assert.equal(verifyGrant('dl:zzzz-zzzz', token), false, 'grant is slug-scoped');
    assert.equal(verifyGrant('dl:abcd-efgh', 'garbage'), false);
    assert.equal(verifyGrant('dl:abcd-efgh', signGrant('dl:abcd-efgh', -1)), false, 'expired');
  });
});
