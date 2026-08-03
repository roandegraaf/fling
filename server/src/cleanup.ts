import fsp from 'node:fs/promises';
import { BLOB_DIR } from './env.ts';
import { q } from './db.ts';
import { getSettings } from './settings.ts';
import { deleteTransferBlobs } from './storage.ts';

export interface CleanupResult {
  expired: number;
  stalled: number;
  orphans: number;
  sessions: number;
}

type Logger = { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };

/**
 * Deletes what should no longer exist: expired transfers, abandoned half-finished
 * uploads, blob folders with no matching row, and stale admin sessions.
 * Safe to run concurrently with uploads — it only touches rows it has selected.
 */
export async function runCleanup(log?: Logger): Promise<CleanupResult> {
  const now = Date.now();
  const settings = getSettings();
  const result: CleanupResult = { expired: 0, stalled: 0, orphans: 0, sessions: 0 };

  for (const transfer of q.expiredTransfers.all(now)) {
    try {
      q.deleteTransfer.run(transfer.id);
      await deleteTransferBlobs(transfer.id);
      result.expired++;
    } catch (err) {
      log?.error({ err, transferId: transfer.id }, 'failed to delete expired transfer');
    }
  }

  const stalledBefore = now - settings.incompleteUploadTtlHours * 3_600_000;
  for (const transfer of q.stalledUploads.all(stalledBefore)) {
    try {
      q.deleteTransfer.run(transfer.id);
      await deleteTransferBlobs(transfer.id);
      result.stalled++;
    } catch (err) {
      log?.error({ err, transferId: transfer.id }, 'failed to delete stalled upload');
    }
  }

  // Blob folders with no transfer row — e.g. a crash between the two deletes.
  try {
    const dirs = await fsp.readdir(BLOB_DIR, { withFileTypes: true });
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue;
      if (q.transferById.get(entry.name)) continue;
      try {
        await deleteTransferBlobs(entry.name);
        result.orphans++;
      } catch (err) {
        log?.error({ err, dir: entry.name }, 'failed to delete orphan blob dir');
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log?.error({ err }, 'failed to scan blob dir');
    }
  }

  try {
    result.sessions = q.purgeAdminSessions.run(now).changes;
    // Download sessions only matter while a visitor might still return; a day
    // is well past the recognise-a-returning-visitor window.
    result.sessions += q.purgeDownloadSessions.run(now - 24 * 3_600_000).changes;
  } catch (err) {
    log?.error({ err }, 'failed to purge sessions');
  }

  const touched = result.expired + result.stalled + result.orphans;
  if (touched > 0) log?.info(result, 'cleanup removed transfers');
  return result;
}

/**
 * Self-rescheduling loop rather than setInterval, so a change to the interval in
 * the admin page takes effect on the next tick and a slow sweep never overlaps
 * itself.
 */
export function startCleanupLoop(log: Logger): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await runCleanup(log);
    } catch (err) {
      log.error({ err }, 'cleanup failed');
    }
    if (stopped) return;
    const minutes = getSettings().cleanupIntervalMinutes;
    timer = setTimeout(tick, minutes * 60_000);
    timer.unref?.();
  };

  // First sweep shortly after boot, so a restart tidies up right away.
  timer = setTimeout(tick, 10_000);
  timer.unref?.();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
