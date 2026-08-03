import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, describe, test } from 'node:test';

const execFileAsync = promisify(execFile);

const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'fling-zip-'));
process.env.FLING_CONFIG_DIR = path.join(scratch, 'config');
process.env.FLING_DATA_DIR = path.join(scratch, 'data');

const { CHUNK_SIZE } = await import('./crypto.ts');
const { allocateBlob, writeChunk, chunkCountFor } = await import('./storage.ts');
const { createZip } = await import('./zip.ts');
const { newBitmap } = await import('./db.ts');
import type { FileRow } from './db.ts';
import type { ZipEntry } from './zip.ts';

after(async () => {
  await fsp.rm(scratch, { recursive: true, force: true });
});

const transferId = randomUUID();

/** Creates a real encrypted blob and the row that describes it. */
async function makeFile(relPath: string, size: number): Promise<FileRow> {
  const id = randomUUID();
  const row: FileRow = {
    id,
    transfer_id: transferId,
    path: relPath,
    size,
    chunk_size: CHUNK_SIZE,
    chunk_count: chunkCountFor(size, CHUNK_SIZE),
    received_bitmap: newBitmap(chunkCountFor(size, CHUNK_SIZE)),
    received_count: 0,
    complete: 1,
    sort_order: 0,
  };
  await allocateBlob(transferId, id, size, CHUNK_SIZE);
  if (size > 0) {
    await writeChunk(transferId, id, 0, CHUNK_SIZE, size, randomBytes(size));
  }
  return row;
}

async function measure(entries: ZipEntry[], emptyDirs: string[] = []) {
  const built = await createZip(entries, emptyDirs, new Date(1_700_000_000_000));
  let actual = 0;
  const parts: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    built.stream.on('data', (chunk: Buffer) => {
      actual += chunk.length;
      parts.push(chunk);
    });
    built.stream.on('end', resolve);
    built.stream.on('error', reject);
  });
  return { declared: built.size, actual, buffer: Buffer.concat(parts) };
}

describe('zip archive size', () => {
  /**
   * Regression: yazl 3.3.1 predicts a zip64 end-of-central-directory once the
   * central directory passes 0xffff bytes, but only writes one past 0xffffffff.
   * That made Content-Length 76 bytes too large for archives of roughly 800+
   * files — the browser waited for bytes that never came and the download died
   * near the end. These counts straddle that boundary deliberately.
   */
  test('declared size matches the bytes actually produced, across the zip64 boundary', async () => {
    const counts = [1, 2, 50, 500, 700, 900, 1200, 2000];
    const pool: FileRow[] = [];
    for (let i = 0; i < Math.max(...counts); i++) {
      // Names long enough that ~800 entries push the central directory over 64 KB.
      pool.push(await makeFile(`Shoot/${String(Math.floor(i / 100)).padStart(2, '0')}/IMG_${String(i).padStart(5, '0')}.CR3`, 24));
    }

    for (const count of counts) {
      const entries = pool.slice(0, count).map((file) => ({ file, name: file.path }));
      const { declared, actual } = await measure(entries);
      assert.equal(
        declared,
        actual,
        `Content-Length would be wrong for ${count} entries (declared ${declared}, actual ${actual})`,
      );
    }
  });

  test('the boundary-crossing archive is a valid, extractable zip', async () => {
    const files: FileRow[] = [];
    for (let i = 0; i < 1200; i++) {
      files.push(await makeFile(`Deep/Folder/name-${String(i).padStart(5, '0')}.bin`, 16));
    }
    const entries = files.map((file) => ({ file, name: file.path }));
    const { declared, actual, buffer } = await measure(entries);
    assert.equal(declared, actual);

    const zipPath = path.join(scratch, 'boundary.zip');
    await fsp.writeFile(zipPath, buffer);

    try {
      await execFileAsync('unzip', ['-t', zipPath]);
    } catch (err) {
      assert.fail(`unzip rejected the archive: ${(err as Error).message}`);
    }

    const { stdout } = await execFileAsync('unzip', ['-Z1', zipPath]);
    const names = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    assert.equal(names.length, 1200);
  });

  test('empty folders and unicode names keep the size exact', async () => {
    const files = [
      await makeFile('Ünïcøde ✨/naïve café.txt', 12),
      await makeFile('Ünïcøde ✨/second.txt', 0),
      await makeFile('top-level.bin', 5),
    ];
    const entries = files.map((file) => ({ file, name: file.path }));
    const { declared, actual, buffer } = await measure(entries, ['Ünïcøde ✨/Empty', 'Another empty']);
    assert.equal(declared, actual);

    const zipPath = path.join(scratch, 'unicode.zip');
    await fsp.writeFile(zipPath, buffer);
    await execFileAsync('unzip', ['-t', zipPath]);

    const { stdout } = await execFileAsync('unzip', ['-Z1', zipPath]);
    assert.ok(stdout.includes('naïve café.txt'), 'unicode name survives the round trip');
    assert.ok(
      stdout.split('\n').some((n) => n.trim().startsWith('Another empty')),
      'empty directories are present',
    );
  });

  test('a zero-file archive of only empty folders still measures correctly', async () => {
    const { declared, actual } = await measure([], ['Just/An/Empty/Tree']);
    assert.equal(declared, actual);
  });
});
