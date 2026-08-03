import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { BLOB_DIR } from './env.ts';
import { TAG_LEN, openChunk, sealChunk } from './crypto.ts';
import type { FileRow } from './db.ts';

export function transferDir(transferId: string): string {
  return path.join(BLOB_DIR, transferId);
}

export function blobPath(transferId: string, fileId: string): string {
  return path.join(transferDir(transferId), `${fileId}.bin`);
}

export function chunkCountFor(size: number, chunkSize: number): number {
  return size === 0 ? 0 : Math.ceil(size / chunkSize);
}

/** Plaintext length of chunk `index` for a file of `size` bytes. */
export function plainChunkLength(size: number, chunkSize: number, index: number): number {
  const start = index * chunkSize;
  if (start >= size) return 0;
  return Math.min(chunkSize, size - start);
}

/** Total on-disk length: every chunk carries its own 16-byte tag. */
export function sealedLength(size: number, chunkSize: number): number {
  return size + chunkCountFor(size, chunkSize) * TAG_LEN;
}

/**
 * Creates the blob as a sparse file of its final length so chunks can be written
 * at their fixed offsets in any order.
 */
export async function allocateBlob(
  transferId: string,
  fileId: string,
  size: number,
  chunkSize: number,
): Promise<void> {
  await fsp.mkdir(transferDir(transferId), { recursive: true });
  const target = blobPath(transferId, fileId);
  const fh = await fsp.open(target, 'a+');
  try {
    await fh.truncate(sealedLength(size, chunkSize));
  } finally {
    await fh.close();
  }
}

/**
 * Seals one plaintext chunk and writes it at its deterministic offset.
 *
 * Durability: the data is fsync'd here, and only *after* this resolves does the
 * caller set the chunk's bit in SQLite. A crash in between just means the chunk
 * gets re-sent and overwrites the same offset — idempotent by construction.
 */
export async function writeChunk(
  transferId: string,
  fileId: string,
  chunkIndex: number,
  chunkSize: number,
  size: number,
  plaintext: Buffer,
): Promise<void> {
  const sealed = sealChunk(fileId, chunkIndex, plaintext);
  const target = blobPath(transferId, fileId);

  let fh;
  try {
    fh = await fsp.open(target, 'r+');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // First chunk to arrive for this file allocates it. Two chunks racing here
    // both truncate to the same final length, which is a no-op for the loser.
    await allocateBlob(transferId, fileId, size, chunkSize);
    fh = await fsp.open(target, 'r+');
  }

  try {
    await fh.write(sealed, 0, sealed.length, chunkIndex * (chunkSize + TAG_LEN));
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

/**
 * A readable stream of decrypted plaintext for `[start, end]` (inclusive, HTTP
 * Range semantics). Only the chunks covering that window are read and decrypted,
 * which is what makes seeking in a 20 GB encrypted video cheap.
 */
export function createDecryptedStream(file: FileRow, start = 0, end = file.size - 1): Readable {
  const { id: fileId, transfer_id: transferId, size, chunk_size: chunkSize } = file;

  if (size === 0 || start > end || start >= size) {
    return Readable.from([]);
  }

  const from = Math.max(0, start);
  const to = Math.min(end, size - 1);
  const stride = chunkSize + TAG_LEN;
  const firstChunk = Math.floor(from / chunkSize);
  const lastChunk = Math.floor(to / chunkSize);

  async function* generate(): AsyncGenerator<Buffer> {
    const fh = await fsp.open(blobPath(transferId, fileId), 'r');
    try {
      for (let i = firstChunk; i <= lastChunk; i++) {
        const plainLen = plainChunkLength(size, chunkSize, i);
        if (plainLen === 0) break;

        const sealed = Buffer.allocUnsafe(plainLen + TAG_LEN);
        const { bytesRead } = await fh.read(sealed, 0, sealed.length, i * stride);
        if (bytesRead !== sealed.length) {
          throw new Error(`blob ${fileId} is truncated at chunk ${i}`);
        }

        const plain = openChunk(fileId, i, sealed);
        const chunkStart = i * chunkSize;
        const sliceFrom = i === firstChunk ? from - chunkStart : 0;
        const sliceTo = i === lastChunk ? to - chunkStart + 1 : plain.length;
        yield plain.subarray(sliceFrom, sliceTo);
      }
    } finally {
      await fh.close();
    }
  }

  return Readable.from(generate());
}

export async function deleteTransferBlobs(transferId: string): Promise<void> {
  await fsp.rm(transferDir(transferId), { recursive: true, force: true });
}

/** Actual bytes consumed on the share, tags included. */
export async function diskUsage(): Promise<number> {
  let total = 0;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          total += (await fsp.stat(full)).size;
        } catch {
          /* raced with cleanup */
        }
      }
    }
  }
  await walk(BLOB_DIR);
  return total;
}
