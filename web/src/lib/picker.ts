export interface PickedFile {
  /** Relative path including the filename, e.g. `Shoot/RAW/IMG_0041.CR3`. */
  path: string;
  file: File;
}

export interface Picked {
  files: PickedFile[];
  /** Folders that contain no files at all — otherwise they'd vanish. */
  emptyDirs: string[];
  /** True when the tree was bigger than `limit` and had to be cut short. */
  truncated: boolean;
}

const EMPTY: Picked = { files: [], emptyDirs: [], truncated: false };

/**
 * `DataTransferItemList` is only valid during the drop event, so the entries
 * must be grabbed synchronously in the handler before any `await`. Walking them
 * afterwards is fine.
 */
export function entriesFromDrop(dataTransfer: DataTransfer): {
  entries: FileSystemEntry[];
  plainFiles: File[];
} {
  const entries: FileSystemEntry[] = [];
  const plainFiles: File[] = [];

  const items = dataTransfer.items;
  if (items && items.length > 0) {
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry) {
        entries.push(entry);
      } else {
        const file = item.getAsFile();
        if (file) plainFiles.push(file);
      }
    }
  }

  // Browsers without the entry API still give us a flat file list.
  if (entries.length === 0 && plainFiles.length === 0 && dataTransfer.files?.length) {
    plainFiles.push(...Array.from(dataTransfer.files));
  }

  return { entries, plainFiles };
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** Walks dropped entries into a flat list of files with their relative paths. */
export async function walkEntries(
  entries: FileSystemEntry[],
  plainFiles: File[] = [],
  limit = 5000,
): Promise<Picked> {
  if (entries.length === 0 && plainFiles.length === 0) return EMPTY;

  const files: PickedFile[] = [];
  const emptyDirs: string[] = [];
  let truncated = false;

  for (const file of plainFiles) {
    if (files.length >= limit) return { files, emptyDirs, truncated: true };
    files.push({ path: file.name, file });
  }

  async function visit(entry: FileSystemEntry, prefix: string): Promise<void> {
    if (truncated) return;

    if (entry.isFile) {
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      try {
        const file = await fileOf(entry as FileSystemFileEntry);
        files.push({ path: prefix ? `${prefix}/${entry.name}` : entry.name, file });
      } catch {
        // Unreadable file (permissions, or it moved) — skip rather than fail the drop.
      }
      return;
    }

    if (!entry.isDirectory) return;

    const dirPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children: FileSystemEntry[] = [];

    // readEntries returns at most ~100 per call, so keep going until it's empty.
    for (let guard = 0; guard < 10_000; guard++) {
      let batch: FileSystemEntry[];
      try {
        batch = await readBatch(reader);
      } catch {
        break;
      }
      if (batch.length === 0) break;
      children.push(...batch);
    }

    if (children.length === 0) {
      emptyDirs.push(dirPath);
      return;
    }
    for (const child of children) await visit(child, dirPath);
  }

  for (const entry of entries) await visit(entry, '');
  return { files, emptyDirs, truncated };
}

/** `<input type="file">` and `<input webkitdirectory>` both land here. */
export function fromFileList(list: FileList | null, limit = 5000): Picked {
  if (!list || list.length === 0) return EMPTY;

  const files: PickedFile[] = [];
  let truncated = false;

  for (const file of Array.from(list)) {
    if (files.length >= limit) {
      truncated = true;
      break;
    }
    // webkitRelativePath is set only for directory picks.
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    files.push({ path: relative && relative.length > 0 ? relative : file.name, file });
  }

  return { files, emptyDirs: [], truncated };
}

/** Keeps the first of each path, so re-dropping the same folder can't duplicate it. */
export function mergePicked(current: PickedFile[], incoming: PickedFile[]): PickedFile[] {
  const seen = new Set(current.map((f) => f.path));
  const merged = [...current];
  for (const item of incoming) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    merged.push(item);
  }
  return merged;
}
