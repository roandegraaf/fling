import type { CreatedFile } from './api';

export type UploadPhase = 'idle' | 'uploading' | 'paused' | 'error' | 'done' | 'canceled';

export type FileState = 'pending' | 'uploading' | 'done';

export interface FileProgress {
  id: string;
  path: string;
  size: number;
  uploaded: number;
  state: FileState;
}

export interface UploadSnapshot {
  phase: UploadPhase;
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
  bytesPerSecond: number;
  etaSeconds: number;
  files: FileProgress[];
  error: string | null;
  /** True when the failure looks like a dropped connection rather than a rejection. */
  resumable: boolean;
}

interface Task {
  fileId: string;
  index: number;
  start: number;
  end: number;
  bytes: number;
}

interface UploaderOptions {
  transferId: string;
  uploadToken: string;
  files: CreatedFile[];
  /**
   * File id → the actual File the user picked. Keyed by id rather than path
   * because the server renames duplicate paths, so its path may not be the one
   * the browser knows the file by.
   */
  blobs: Map<string, File>;
  concurrency?: number;
  maxAttempts?: number;
  onChange: (snapshot: UploadSnapshot) => void;
}

/** Statuses that mean "stop, retrying will not help". */
const FATAL_STATUSES = new Set([400, 403, 404, 409, 410, 413, 507]);

/**
 * Uploads a transfer's files as fixed-size chunks with a bounded number of
 * requests in flight, per-chunk retry with exponential backoff, and the ability
 * to resume from whatever the server already has.
 */
export class Uploader {
  private readonly opts: Required<Omit<UploaderOptions, 'onChange'>> & {
    onChange: UploaderOptions['onChange'];
  };

  private queue: Task[] = [];
  private active = new Set<XMLHttpRequest>();
  private chunkProgress = new Map<string, number>();
  private fileState = new Map<string, FileState>();
  private fileSizes = new Map<string, number>();
  private filePaths = new Map<string, string>();
  private fileUploaded = new Map<string, number>();

  private phase: UploadPhase = 'idle';
  private errorMessage: string | null = null;
  private resumable = false;
  private totalBytes = 0;
  private samples: Array<{ t: number; bytes: number }> = [];
  private runners = 0;
  private notifyScheduled = false;

  constructor(options: UploaderOptions) {
    this.opts = {
      concurrency: 3,
      maxAttempts: 6,
      ...options,
    } as Uploader['opts'];

    for (const file of options.files) {
      this.fileSizes.set(file.id, file.size);
      this.filePaths.set(file.id, file.path);
      this.fileUploaded.set(file.id, file.complete ? file.size : 0);
      this.fileState.set(file.id, file.complete ? 'done' : 'pending');
      this.totalBytes += file.size;
    }
  }

  /** Rebuilds the work queue from the chunks the server says it is missing. */
  setMissing(missingByFile: Map<string, number[]>): void {
    this.queue = [];
    this.chunkProgress.clear();

    for (const file of this.opts.files) {
      const missing = missingByFile.get(file.id);

      if (!missing || missing.length === 0) {
        this.fileState.set(file.id, 'done');
        this.fileUploaded.set(file.id, file.size);
        continue;
      }

      const missingBytes = missing.reduce(
        (sum, index) => sum + chunkBytes(file.size, file.chunkSize, index),
        0,
      );
      this.fileState.set(file.id, 'pending');
      this.fileUploaded.set(file.id, Math.max(0, file.size - missingBytes));

      for (const index of missing) {
        const start = index * file.chunkSize;
        const end = Math.min(start + file.chunkSize, file.size);
        this.queue.push({ fileId: file.id, index, start, end, bytes: end - start });
      }
    }

    // Smallest files first: they finish quickly, so the list visibly progresses.
    this.queue.sort((a, b) => {
      const sizeA = this.fileSizes.get(a.fileId) ?? 0;
      const sizeB = this.fileSizes.get(b.fileId) ?? 0;
      if (sizeA !== sizeB) return sizeA - sizeB;
      return a.index - b.index;
    });

    this.emit();
  }

  start(): void {
    if (this.phase === 'uploading' || this.phase === 'done') return;
    this.errorMessage = null;
    this.resumable = false;
    this.phase = this.queue.length === 0 ? 'done' : 'uploading';
    this.samples = [{ t: Date.now(), bytes: this.uploadedBytes() }];
    this.emit();
    this.pump();
  }

  pause(): void {
    if (this.phase !== 'uploading') return;
    this.phase = 'paused';
    this.abortActive();
    this.emit();
  }

  cancel(): void {
    this.phase = 'canceled';
    this.queue = [];
    this.abortActive();
    this.emit();
  }

  get snapshot(): UploadSnapshot {
    const uploaded = this.uploadedBytes();
    const speed = this.speed();
    const remaining = Math.max(0, this.totalBytes - uploaded);

    return {
      phase: this.phase,
      uploadedBytes: uploaded,
      totalBytes: this.totalBytes,
      percent: this.totalBytes === 0 ? 100 : Math.min(100, (uploaded / this.totalBytes) * 100),
      bytesPerSecond: speed,
      etaSeconds: speed > 0 ? remaining / speed : Infinity,
      files: this.opts.files.map((file) => ({
        id: file.id,
        path: file.path,
        size: file.size,
        uploaded: Math.min(file.size, this.fileUploaded.get(file.id) ?? 0),
        state: this.fileState.get(file.id) ?? 'pending',
      })),
      error: this.errorMessage,
      resumable: this.resumable,
    };
  }

  /* ── internals ─────────────────────────────────────────────────────────── */

  private abortActive(): void {
    for (const xhr of this.active) xhr.abort();
    this.active.clear();
    this.chunkProgress.clear();
  }

  private uploadedBytes(): number {
    let total = 0;
    for (const value of this.fileUploaded.values()) total += value;
    for (const value of this.chunkProgress.values()) total += value;
    return Math.min(total, this.totalBytes);
  }

  /** Bytes/sec over roughly the last 8 seconds, so the ETA is not jumpy. */
  private speed(): number {
    const now = Date.now();
    const recent = this.samples.filter((s) => now - s.t < 8000);
    if (recent.length < 2) return 0;

    const first = recent[0];
    const last = recent[recent.length - 1];
    const seconds = (last.t - first.t) / 1000;
    if (seconds <= 0) return 0;
    return Math.max(0, (last.bytes - first.bytes) / seconds);
  }

  /** Coalesces the many per-chunk progress events into one render per frame. */
  private emit(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    const flush = (): void => {
      this.notifyScheduled = false;
      this.samples.push({ t: Date.now(), bytes: this.uploadedBytes() });
      if (this.samples.length > 200) this.samples.splice(0, this.samples.length - 200);
      this.opts.onChange(this.snapshot);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }

  private pump(): void {
    while (this.phase === 'uploading' && this.runners < this.opts.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.runners++;
      void this.runTask(task).finally(() => {
        this.runners--;
        if (this.phase === 'uploading') {
          if (this.queue.length > 0) this.pump();
          else if (this.runners === 0) this.finish();
        }
      });
    }

    if (this.phase === 'uploading' && this.queue.length === 0 && this.runners === 0) {
      this.finish();
    }
  }

  private finish(): void {
    this.phase = 'done';
    for (const file of this.opts.files) {
      this.fileState.set(file.id, 'done');
      this.fileUploaded.set(file.id, file.size);
    }
    this.emit();
  }

  private async runTask(task: Task): Promise<void> {
    const blob = this.opts.blobs.get(task.fileId);

    if (!blob) {
      const path = this.filePaths.get(task.fileId) ?? 'A file';
      this.fail(`${path} is no longer available in the browser.`, false);
      return;
    }

    this.fileState.set(task.fileId, 'uploading');
    const key = `${task.fileId}:${task.index}`;

    for (let attempt = 0; attempt < this.opts.maxAttempts; attempt++) {
      if (this.phase !== 'uploading') return;

      try {
        await this.sendChunk(task, blob, key);

        this.chunkProgress.delete(key);
        this.fileUploaded.set(task.fileId, (this.fileUploaded.get(task.fileId) ?? 0) + task.bytes);

        const size = this.fileSizes.get(task.fileId) ?? 0;
        if ((this.fileUploaded.get(task.fileId) ?? 0) >= size) {
          this.fileState.set(task.fileId, 'done');
        }
        this.emit();
        return;
      } catch (err) {
        this.chunkProgress.delete(key);

        if (this.phase !== 'uploading') return;

        const status = err instanceof ChunkError ? err.status : 0;
        if (FATAL_STATUSES.has(status)) {
          this.fail(
            err instanceof ChunkError && err.serverMessage
              ? err.serverMessage
              : `Upload rejected by the server (${status}).`,
            false,
          );
          return;
        }

        if (attempt === this.opts.maxAttempts - 1) {
          // Out of retries: keep the chunk so "Resume" can pick it back up.
          this.queue.unshift(task);
          this.fail('The connection dropped.', true);
          return;
        }

        const backoff = Math.min(15_000, 500 * 2 ** attempt) + Math.random() * 400;
        await sleep(backoff);
      }
    }
  }

  private sendChunk(task: Task, blob: File, key: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const url = `/api/transfers/${this.opts.transferId}/files/${task.fileId}/chunks/${task.index}`;

      xhr.open('PUT', url, true);
      xhr.setRequestHeader('authorization', `Bearer ${this.opts.uploadToken}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.timeout = 5 * 60_000;

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        this.chunkProgress.set(key, Math.min(event.loaded, task.bytes));
        this.emit();
      };

      xhr.onload = () => {
        this.active.delete(xhr);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
          return;
        }
        reject(new ChunkError(xhr.status, messageFrom(xhr.responseText)));
      };

      xhr.onerror = () => {
        this.active.delete(xhr);
        reject(new ChunkError(0, null));
      };
      xhr.ontimeout = () => {
        this.active.delete(xhr);
        reject(new ChunkError(0, null));
      };
      xhr.onabort = () => {
        this.active.delete(xhr);
        reject(new ChunkError(-1, null));
      };

      this.active.add(xhr);
      xhr.send(blob.slice(task.start, task.end));
    });
  }

  private fail(message: string, resumable: boolean): void {
    if (this.phase === 'canceled') return;
    this.phase = 'error';
    this.errorMessage = message;
    this.resumable = resumable;
    this.abortActive();
    this.emit();
  }
}

class ChunkError extends Error {
  constructor(
    readonly status: number,
    readonly serverMessage: string | null,
  ) {
    super(serverMessage ?? `chunk failed (${status})`);
  }
}

function messageFrom(responseText: string): string | null {
  try {
    const parsed = JSON.parse(responseText) as { message?: string; error?: string };
    return parsed.message ?? parsed.error ?? null;
  } catch {
    return null;
  }
}

function chunkBytes(size: number, chunkSize: number, index: number): number {
  const start = index * chunkSize;
  return Math.max(0, Math.min(chunkSize, size - start));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
