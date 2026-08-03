import yazl from 'yazl';
import type { Readable } from 'node:stream';
import type { FileRow } from './db.ts';
import { createDecryptedStream } from './storage.ts';

const FOUR_GIB = 0xfffffffe;
const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;
const MAX_ENTRIES_ZIP32 = 0xfffe;

/**
 * Upper bounds on yazl's own per-entry accounting, used to decide the zip64
 * end-of-central-directory question *before* the archive is written.
 *
 * Central directory record: 46 fixed + name + 9 (info-zip timestamp extra)
 *                           + 28 (zip64 extra, counted always to stay an upper bound)
 * Local header + payload:   30 fixed + name + 24 (max data descriptor)
 */
const CD_PER_ENTRY_MAX = 46 + 9 + 28;
const LOCAL_PER_ENTRY_MAX = 30 + 24;

export interface ZipEntry {
  file: FileRow;
  /** Path inside the archive. */
  name: string;
}

export interface BuiltZip {
  stream: Readable;
  /** Exact byte length of the archive, so the browser can show a real progress bar. */
  size: number;
}

/**
 * yazl decides whether to emit a zip64 end-of-central-directory in two places,
 * and in v3.3.1 the two disagree: the size *prediction* triggers on a central
 * directory of `>= 0xffff` bytes, while the *writer* triggers on `>= 0xffffffff`.
 * For any archive between those (roughly 800+ files) the predicted size is 76
 * bytes — one zip64 EOCD record plus its locator — larger than the bytes
 * actually produced. Sending that as Content-Length makes the client wait for
 * data that never arrives, and the download dies near the end.
 *
 * Both code paths short-circuit on the explicit `forceZip64Format` flag, so
 * deciding it here ourselves makes them agree by construction. The bounds below
 * are deliberate over-estimates of yazl's real numbers: if the true central
 * directory would cross a threshold then so does our bound, and if our bound
 * stays under it then the true one does too. Either way the two branches match.
 */
function zip64Plan(entries: ZipEntry[], emptyDirs: string[]) {
  const totalBytes = entries.reduce((sum, e) => sum + e.file.size, 0);
  const entryCount = entries.length + emptyDirs.length;

  let centralDirectoryMax = 0;
  let cursorMax = totalBytes;

  for (const entry of entries) {
    const nameLength = Buffer.byteLength(entry.name, 'utf8');
    centralDirectoryMax += CD_PER_ENTRY_MAX + nameLength;
    cursorMax += LOCAL_PER_ENTRY_MAX + nameLength;
  }
  for (const dir of emptyDirs) {
    const nameLength = Buffer.byteLength(dir, 'utf8') + 1; // trailing slash
    centralDirectoryMax += CD_PER_ENTRY_MAX + nameLength;
    cursorMax += LOCAL_PER_ENTRY_MAX + nameLength;
  }

  // Individual entries need zip64 headers once any file — or the running offset
  // into the archive — can exceed 32 bits.
  const perEntry =
    totalBytes >= FOUR_GIB ||
    entryCount >= MAX_ENTRIES_ZIP32 ||
    entries.some((e) => e.file.size >= FOUR_GIB);

  const eocd =
    perEntry ||
    entryCount >= UINT16_MAX ||
    centralDirectoryMax >= UINT16_MAX ||
    cursorMax >= UINT32_MAX;

  return { perEntry, eocd };
}

/**
 * Streams a zip of already-encrypted files, decrypting each one lazily.
 *
 * Stored, never deflated: the payloads here are typically already-compressed
 * media, and CPU is the scarce resource on an Unraid box. Storing also means
 * every entry's compressed size is known up front, which lets yazl pre-compute
 * the total archive size — so downloads get a real Content-Length instead of a
 * spinner of unknown duration.
 */
export function createZip(
  entries: ZipEntry[],
  emptyDirs: string[],
  mtime: Date,
  onError?: (err: Error) => void,
): Promise<BuiltZip> {
  const zip = new yazl.ZipFile();
  const plan = zip64Plan(entries, emptyDirs);

  for (const dir of emptyDirs) {
    zip.addEmptyDirectory(dir.endsWith('/') ? dir : `${dir}/`, { mtime });
  }

  for (const { file, name } of entries) {
    zip.addReadStreamLazy(
      name,
      {
        size: file.size,
        compress: false,
        mtime,
        forceZip64Format: plan.perEntry,
      },
      (cb: (err: Error | null, stream?: Readable) => void) => {
        try {
          cb(null, createDecryptedStream(file));
        } catch (err) {
          cb(err as Error);
        }
      },
    );
  }

  return new Promise<BuiltZip>((resolve, reject) => {
    let settled = false;

    zip.on('error', (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
        return;
      }
      // Already streaming to the client: headers are gone, so the best we can do
      // is surface it and cut the connection rather than hang.
      onError?.(err);
      zip.outputStream.destroy(err);
    });

    zip.end({ forceZip64Format: plan.eocd }, (finalSize: number) => {
      if (settled) return;
      settled = true;
      resolve({ stream: zip.outputStream as unknown as Readable, size: finalSize });
    });
  });
}

