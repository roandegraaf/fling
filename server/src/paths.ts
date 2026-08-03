/**
 * Relative paths coming from the browser are *metadata only* — blobs are stored
 * under opaque ids, never under user-supplied names. These helpers make sure the
 * paths are still safe to put in a zip entry, render in HTML, or store in SQLite.
 */

const MAX_SEGMENT = 200;
const MAX_PATH = 1024;

/** Returns a normalised `a/b/c.txt` style path, or null when it is unusable. */
export function sanitizeRelPath(input: unknown): string | null {
  if (typeof input !== 'string') return null;

  let value = input.replace(/\\/g, '/').trim();
  if (!value) return null;
  if (value.includes('\0')) return null;
  if (/^[a-zA-Z]:/.test(value)) return null; // C:\...
  if (value.startsWith('//')) return null; // UNC

  const segments = value
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== '.');

  if (segments.length === 0) return null;
  if (segments.some((s) => s === '..')) return null;
  // Control characters break zip readers and terminal output.
  if (segments.some((s) => /[\u0000-\u001f\u007f]/.test(s))) return null;
  if (segments.some((s) => s.length > MAX_SEGMENT)) return null;

  const joined = segments.join('/');
  return joined.length > MAX_PATH ? null : joined;
}

export function basenameOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

/** Every ancestor folder of a path, shallowest first. */
export function ancestorsOf(relPath: string): string[] {
  const parts = relPath.split('/');
  parts.pop();
  const out: string[] = [];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    out.push(acc);
  }
  return out;
}

export function isInsideFolder(relPath: string, folder: string): boolean {
  if (!folder) return true;
  return relPath.startsWith(`${folder}/`);
}

/** Filesystem-safe name for a generated download, e.g. the zip filename. */
export function safeDownloadName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || fallback;
}
