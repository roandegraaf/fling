import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { BLOB_DIR } from './env.ts';
import { TAG_LEN, openChunk, sealChunk } from './crypto.ts';
import { storedSizeOf, type FileCodec, type FileRow } from './db.ts';

export function transferDir(transferId: string): string {
  return path.join(BLOB_DIR, transferId);
}

/**
 * Each storage variant gets its own file *and* its own key (see crypto.ts), so a
 * recompressed blob is written alongside the original rather than over it. The
 * original is only unlinked once the database points at the new one, which keeps
 * every crash window recoverable in the direction of "leaks a file" rather than
 * "loses the data".
 */
export function blobPath(transferId: string, fileId: string, codec: FileCodec = null): string {
  const suffix = codec ? `.${codec}.bin` : '.bin';
  return path.join(transferDir(transferId), `${fileId}${suffix}`);
}

/** The key/AAD variant that pairs with a codec. Empty keeps v1 blobs readable. */
export function variantFor(codec: FileCodec): string {
  return codec ?? '';
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
 * Writes a complete alternate-codec blob in one pass, chunked and sealed exactly
 * like an uploaded one. Fsync'd before returning, because the caller flips the
 * database row straight afterwards and that row is what makes the blob load-bearing.
 */
export async function writeWholeBlob(
  transferId: string,
  fileId: string,
  codec: FileCodec,
  chunkSize: number,
  plaintext: Buffer,
): Promise<void> {
  await fsp.mkdir(transferDir(transferId), { recursive: true });
  const target = blobPath(transferId, fileId, codec);
  const variant = variantFor(codec);
  const fh = await fsp.open(target, 'w');
  try {
    for (let i = 0; i * chunkSize < plaintext.length; i++) {
      const slice = plaintext.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, plaintext.length));
      const sealed = sealChunk(fileId, i, slice, variant);
      await fh.write(sealed, 0, sealed.length, i * (chunkSize + TAG_LEN));
    }
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

export async function removeBlob(
  transferId: string,
  fileId: string,
  codec: FileCodec = null,
): Promise<void> {
  await fsp.rm(blobPath(transferId, fileId, codec), { force: true });
}

/**
 * A readable stream of the blob's own plaintext for `[start, end]` (inclusive,
 * HTTP Range semantics). Only the chunks covering that window are read and
 * decrypted, which is what makes seeking in a 20 GB encrypted video cheap.
 *
 * For an un-recompressed file this *is* the original file. For a recompressed
 * one it is the encoded form — callers wanting the sender's bytes want
 * `createDecryptedStream` instead.
 */
export function createStoredStream(file: FileRow, start = 0, end?: number): Readable {
  const { id: fileId, transfer_id: transferId, chunk_size: chunkSize, codec } = file;
  const size = storedSizeOf(file);
  const last = end ?? size - 1;

  if (size === 0 || start > last || start >= size) {
    return Readable.from([]);
  }

  const from = Math.max(0, start);
  const to = Math.min(last, size - 1);
  const stride = chunkSize + TAG_LEN;
  const firstChunk = Math.floor(from / chunkSize);
  const lastChunk = Math.floor(to / chunkSize);
  const variant = variantFor(codec);

  async function* generate(): AsyncGenerator<Buffer> {
    const fh = await fsp.open(blobPath(transferId, fileId, codec), 'r');
    try {
      for (let i = firstChunk; i <= lastChunk; i++) {
        const plainLen = plainChunkLength(size, chunkSize, i);
        if (plainLen === 0) break;

        const sealed = Buffer.allocUnsafe(plainLen + TAG_LEN);
        const { bytesRead } = await fh.read(sealed, 0, sealed.length, i * stride);
        if (bytesRead !== sealed.length) {
          throw new Error(`blob ${fileId} is truncated at chunk ${i}`);
        }

        const plain = openChunk(fileId, i, sealed, variant);
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

/** Collects a stored blob fully into memory. Only for codec'd files, which are size-capped. */
export async function readStored(file: FileRow): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of createStoredStream(file)) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

/**
 * The sender's original bytes, whatever the blob happens to be encoded as.
 * Every download path goes through here, so recompression stays invisible.
 */
export function createDecryptedStream(file: FileRow, start = 0, end = file.size - 1): Readable {
  if (!file.codec) return createStoredStream(file, start, end);

  if (file.size === 0 || start > end || start >= file.size) {
    return Readable.from([]);
  }

  const from = Math.max(0, start);
  const to = Math.min(end, file.size - 1);

  // Decoding is whole-file by nature, so a Range request costs a full decode and
  // then a slice. Acceptable because only small, image-shaped files are ever
  // given a codec (see recompress.ts) — never the 20 GB video this app also has
  // to serve, which stays on the streaming path above.
  async function* generate(): AsyncGenerator<Buffer> {
    const { decode } = await import('./recompress.ts');
    const original = await decode(file);
    if (original.length !== file.size) {
      throw new Error(`decoded ${file.id} to ${original.length} bytes, expected ${file.size}`);
    }
    yield original.subarray(from, to + 1);
  }

  return Readable.from(generate());
}

/** Both blob variants for a file, for cleanup paths that must not miss one. */
export function blobPathsFor(file: FileRow): string[] {
  const paths = [blobPath(file.transfer_id, file.id, null)];
  if (file.codec) paths.push(blobPath(file.transfer_id, file.id, file.codec));
  return paths;
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
