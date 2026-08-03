import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useSpring,
  useTransform,
} from 'motion/react';
import {
  api,
  ApiError,
  type CreatedTransfer,
  type PublicConfig,
  type TransferInfo,
} from '../lib/api';
import { allChunks, missingFromBitmap } from '../lib/bitmap';
import {
  addHistory,
  clearPending,
  getPending,
  setPending,
  type PendingTransfer,
} from '../lib/history';
import {
  fromFileList,
  mergePicked,
  walkEntries,
  type PickedFile,
  type Picked,
} from '../lib/picker';
import { Uploader, type UploadSnapshot } from '../lib/uploader';
import {
  displayUrl,
  extensionOf,
  formatBytes,
  formatEta,
  formatLongDate,
  formatShortDate,
  pluralize,
} from '../lib/format';
import { HeaderLink, Page } from '../components/Layout';
import {
  ChevronDownIcon,
  CloseIcon,
  DrawnCheckIcon,
  LockIcon,
  PlusIcon,
  UploadIcon,
} from '../components/Icons';
import { Button } from '../components/Button';
import { PickerMenu } from '../components/PickerMenu';
import { useWindowDrop } from '../hooks/useWindowDrop';
import {
  cardSwap,
  collapsingRow,
  duration,
  ease,
  rise,
  spring,
  stagger,
} from '../lib/motion';
import { navigate } from '../router';

type Phase = 'compose' | 'uploading' | 'done';

const EXPIRY_CHOICES = [1, 2, 3, 7, 14, 30];
const LIMIT_CHOICES: Array<{ value: number | null; label: string }> = [
  { value: null, label: 'Unlimited' },
  { value: 1, label: '1 download' },
  { value: 3, label: '3 downloads' },
  { value: 5, label: '5 downloads' },
  { value: 10, label: '10 downloads' },
  { value: 25, label: '25 downloads' },
];

export function SendPage({ config }: { config: PublicConfig }) {
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [emptyDirs, setEmptyDirs] = useState<string[]>([]);
  const [expiryDays, setExpiryDays] = useState(
    Math.min(config.defaultExpiryDays, config.maxExpiryDays),
  );
  const [password, setPassword] = useState('');
  const [downloadLimit, setDownloadLimit] = useState<number | null>(null);

  const [phase, setPhase] = useState<Phase>('compose');
  const [snapshot, setSnapshot] = useState<UploadSnapshot | null>(null);
  const [result, setResult] = useState<TransferInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept apart from `error`: this one is the only failure that can strand the
  // uploading view, and it needs its own retry.
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which add-menu is open. The resume banner and the empty-state dropzone can
  // both be on screen at once, so a single boolean would open both.
  const [openMenu, setOpenMenu] = useState<'drop' | 'add' | 'resume' | null>(null);
  const [pending, setPendingLocal] = useState<PendingTransfer | null>(() => getPending());

  const uploaderRef = useRef<Uploader | null>(null);
  const createdRef = useRef<CreatedTransfer | null>(null);
  const finalizingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const totalBytes = useMemo(() => picked.reduce((sum, p) => sum + p.file.size, 0), [picked]);

  const expiryOptions = useMemo(
    () => EXPIRY_CHOICES.filter((d) => d <= config.maxExpiryDays),
    [config.maxExpiryDays],
  );

  /* ── picking ───────────────────────────────────────────────────────────── */

  const absorb = useCallback(
    (incoming: Picked) => {
      setError(null);
      setPicked((current) => mergePicked(current, incoming.files));
      setEmptyDirs((current) => Array.from(new Set([...current, ...incoming.emptyDirs])));
      if (incoming.truncated) {
        setError(`Only the first ${config.maxFileCount} files were added.`);
      }
    },
    [config.maxFileCount],
  );

  const handleDrop = useCallback(
    (payload: { entries: FileSystemEntry[]; plainFiles: File[] }) => {
      if (phase !== 'compose') return;
      void walkEntries(payload.entries, payload.plainFiles, config.maxFileCount)
        .then(absorb)
        .catch(() => setError('That drop could not be read. Try the browse button instead.'));
    },
    [absorb, config.maxFileCount, phase],
  );

  const isOver = useWindowDrop(handleDrop, phase === 'compose');

  const onInputChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    absorb(fromFileList(event.target.files, config.maxFileCount));
    event.target.value = '';
  };

  const removeAt = (path: string): void => {
    setPicked((current) => current.filter((p) => p.path !== path));
  };

  /* ── resume of an interrupted transfer after a reload ──────────────────── */

  const pendingMatch = useMemo(() => {
    if (!pending || picked.length === 0) return null;
    const byPath = new Map(picked.map((p) => [p.path, p.file]));
    const blobs = new Map<string, File>();
    for (const file of pending.files) {
      const blob = byPath.get(file.path);
      if (!blob || blob.size !== file.size) return null;
      blobs.set(file.id, blob);
    }
    return blobs;
  }, [pending, picked]);

  /* ── upload ────────────────────────────────────────────────────────────── */

  /* Called only from event handlers, so a plain function keeps it free of any
     stale-closure hazard around `finalize`. */
  const runUploader = (
    transfer: CreatedTransfer,
    blobs: Map<string, File>,
    missing: Map<string, number[]>,
  ): void => {
    createdRef.current = transfer;
    finalizingRef.current = false;

    const uploader = new Uploader({
      transferId: transfer.transferId,
      uploadToken: transfer.uploadToken,
      files: transfer.files,
      blobs,
      onChange: (snap) => {
        setSnapshot(snap);
        if (snap.phase === 'done' && !finalizingRef.current) {
          finalizingRef.current = true;
          void finalize(transfer);
        }
      },
    });

    uploaderRef.current = uploader;
    uploader.setMissing(missing);
    uploader.start();
    setPhase('uploading');
  };

  const finalize = async (transfer: CreatedTransfer): Promise<void> => {
    try {
      const info = await api.finalize(transfer.transferId, transfer.uploadToken);
      addHistory({
        transferId: transfer.transferId,
        uploadToken: transfer.uploadToken,
        slug: info.slug,
        url: info.url,
        createdAt: Date.now(),
        expiresAt: info.expiresAt,
        totalSize: info.totalSize,
        fileCount: info.fileCount,
        firstName: transfer.files[0]?.path ?? '',
        hasPassword: info.hasPassword,
        downloadLimit: info.downloadLimit,
      });
      clearPending();
      setPendingLocal(null);
      setResult(info);
      setPhase('done');
    } catch (err) {
      finalizingRef.current = false;
      setFinalizeError(err instanceof ApiError ? err.message : 'Could not finish the transfer.');
    }
  };

  const start = async (): Promise<void> => {
    if (picked.length === 0 || busy) return;

    if (picked.length > config.maxFileCount) {
      setError(`This server accepts at most ${config.maxFileCount} files per transfer.`);
      return;
    }
    if (totalBytes > config.maxTransferSize) {
      setError(`That is ${formatBytes(totalBytes)} — the limit is ${formatBytes(config.maxTransferSize)}.`);
      return;
    }

    setBusy(true);
    setError(null);
    setFinalizeError(null);

    try {
      const transfer = await api.createTransfer({
        files: picked.map((p) => ({ path: p.path, size: p.file.size })),
        dirs: emptyDirs,
        expiryDays,
        password: password.length > 0 ? password : undefined,
        downloadLimit,
      });

      setPending({
        transferId: transfer.transferId,
        uploadToken: transfer.uploadToken,
        slug: transfer.slug,
        url: transfer.url,
        createdAt: Date.now(),
        expiresAt: transfer.expiresAt,
        files: transfer.files.map((f) => ({
          id: f.id,
          path: f.path,
          size: f.size,
          chunkSize: f.chunkSize,
          chunkCount: f.chunkCount,
        })),
      });

      // The server answers with one file record per entry sent, in the same
      // order, but may have renamed duplicate paths — so pair by position and
      // key the blobs by the server's file id rather than by path.
      if (transfer.files.length !== picked.length) {
        setError('The server returned an unexpected file list. Try again.');
        return;
      }
      const blobs = new Map(transfer.files.map((f, index) => [f.id, picked[index].file]));
      const missing = new Map(
        transfer.files.map((f) => [f.id, f.complete ? [] : allChunks(f.chunkCount)]),
      );
      runUploader(transfer, blobs, missing);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the transfer.');
    } finally {
      setBusy(false);
    }
  };

  const resumeInterrupted = async (): Promise<void> => {
    if (!pending || !pendingMatch || busy) return;
    setBusy(true);
    setError(null);
    setFinalizeError(null);

    try {
      const status = await api.transferStatus(pending.transferId, pending.uploadToken);
      const transfer: CreatedTransfer = {
        transferId: pending.transferId,
        uploadToken: pending.uploadToken,
        slug: pending.slug,
        url: pending.url,
        expiresAt: pending.expiresAt,
        chunkSize: status.chunkSize,
        files: status.files.map((f) => ({
          id: f.id,
          path: f.path,
          size: f.size,
          chunkSize: f.chunkSize,
          chunkCount: f.chunkCount,
          complete: f.complete,
        })),
      };
      const missing = new Map(
        status.files.map((f) => [
          f.id,
          f.complete ? [] : missingFromBitmap(f.received, f.chunkCount),
        ]),
      );
      runUploader(transfer, pendingMatch, missing);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
        clearPending();
        setPendingLocal(null);
        setError('That interrupted transfer is no longer on the server. Start a new one.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not resume.');
      }
    } finally {
      setBusy(false);
    }
  };

  /** Every chunk landed but the finalize call failed — retry just that step. */
  const retryFinalize = async (): Promise<void> => {
    const transfer = createdRef.current;
    if (!transfer || busy) return;
    setBusy(true);
    setFinalizeError(null);
    finalizingRef.current = true;
    await finalize(transfer);
    setBusy(false);
  };

  const retryAfterDrop = async (): Promise<void> => {
    const transfer = createdRef.current;
    const uploader = uploaderRef.current;
    if (!transfer || !uploader) return;

    setBusy(true);
    setError(null);
    try {
      const status = await api.transferStatus(transfer.transferId, transfer.uploadToken);
      uploader.setMissing(
        new Map(
          status.files.map((f) => [
            f.id,
            f.complete ? [] : missingFromBitmap(f.received, f.chunkCount),
          ]),
        ),
      );
      uploader.start();
    } catch {
      setError('Still no connection to the server.');
    } finally {
      setBusy(false);
    }
  };

  const cancelUpload = async (): Promise<void> => {
    const transfer = createdRef.current;
    uploaderRef.current?.cancel();
    uploaderRef.current = null;
    createdRef.current = null;
    finalizingRef.current = false;
    clearPending();
    setPendingLocal(null);
    setSnapshot(null);
    setError(null);
    setFinalizeError(null);
    setPhase('compose');
    if (transfer) {
      await api.deleteTransfer(transfer.transferId, transfer.uploadToken).catch(() => undefined);
    }
  };

  const reset = (): void => {
    setPicked([]);
    setEmptyDirs([]);
    setPassword('');
    setDownloadLimit(null);
    setResult(null);
    setSnapshot(null);
    setError(null);
    setFinalizeError(null);
    createdRef.current = null;
    uploaderRef.current = null;
    finalizingRef.current = false;
    setPhase('compose');
  };

  const deleteNow = async (): Promise<void> => {
    const transfer = createdRef.current;
    if (!transfer) return;
    await api.deleteTransfer(transfer.transferId, transfer.uploadToken).catch(() => undefined);
    reset();
  };

  /* Warn before losing an in-flight upload. */
  useEffect(() => {
    if (phase !== 'uploading') return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  /* ── render ────────────────────────────────────────────────────────────── */

  const header = <HeaderLink to="/transfers">Your transfers</HeaderLink>;
  const expiresOn = Date.now() + expiryDays * 86_400_000;

  return (
    <Page action={header}>
      <AnimatePresence>
        {isOver && (
          <motion.div
            className="drop-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: duration.quick, ease: ease.out }}
          >
            <motion.div
              className="drop-overlay-inner"
              initial={{ scale: 0.985, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.99, opacity: 0 }}
              transition={spring.soft}
            >
              <UploadIcon size={34} />
              <div className="dropzone-title">Drop to add</div>
              <div className="dropzone-hint">Files and folders both work</div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden-input"
        onChange={onInputChange}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden-input"
        onChange={onInputChange}
        // Not in React's typings, but this is how a folder picker is requested.
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
      />

      {/* One presence tree for the whole flow. Which card is on screen is a
          single decision, so compose → uploading → link reads as one journey
          instead of four unrelated screens. */}
      <AnimatePresence mode="wait">
        {phase === 'done' && result ? (
          <motion.div key="done" variants={cardSwap} initial="hidden" animate="show" exit="out">
            <LinkReady info={result} onAnother={reset} onDelete={deleteNow} />
          </motion.div>
        ) : phase === 'uploading' && snapshot && (finalizeError || snapshot.phase === 'error') ? (
          <motion.div key="stopped" variants={cardSwap} initial="hidden" animate="show" exit="out">
            {/* A failed finalize leaves the snapshot at 100% and healthy, so it
                needs its own branch — otherwise the progress card sits at
                "finishing up" forever. */}
            {finalizeError ? (
              <UploadStopped
                snapshot={snapshot}
                title="Could not finish the transfer"
                message={finalizeError}
                busy={busy}
                onRetry={retryFinalize}
                onCancel={cancelUpload}
              />
            ) : (
              <UploadStopped
                snapshot={snapshot}
                title={
                  snapshot.resumable
                    ? `Connection lost at ${Math.floor(snapshot.percent)}%`
                    : 'Upload failed'
                }
                message={
                  error ??
                  (snapshot.resumable
                    ? 'Nothing was lost. Fling picks up where it stopped.'
                    : (snapshot.error ?? 'The server rejected this transfer.'))
                }
                busy={busy}
                onRetry={snapshot.resumable ? retryAfterDrop : undefined}
                onCancel={cancelUpload}
              />
            )}
          </motion.div>
        ) : phase === 'uploading' && snapshot ? (
          <motion.div
            key="uploading"
            variants={cardSwap}
            initial="hidden"
            animate="show"
            exit="out"
          >
            <UploadProgress snapshot={snapshot} onCancel={cancelUpload} />
          </motion.div>
        ) : picked.length === 0 ? (
          <motion.div
            key="empty"
            variants={stagger(0, 0.06)}
            initial="hidden"
            animate="show"
            exit="out"
          >
            {pending && (
              <motion.div variants={rise} className="card card--pad" style={{ marginBottom: 20 }}>
                <div className="flag">
                  <span className="flag-dot" />
                  <span className="flag-text">Unfinished upload</span>
                </div>
                <div className="title-md" style={{ marginTop: 0 }}>
                  {pluralize(pending.files.length, 'file')} were still uploading
                </div>
                <p className="sub-sm">
                  The server kept every chunk it already had. Add the same files again and Fling
                  continues where it stopped.
                </p>
                <div className="row">
                  <div className="menu-anchor">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOpenMenu((v) => (v === 'resume' ? null : 'resume'))}
                    >
                      Choose them again
                    </Button>
                    <PickerMenu
                      open={openMenu === 'resume'}
                      onClose={() => setOpenMenu(null)}
                      onPickFiles={() => fileInputRef.current?.click()}
                      onPickFolder={() => folderInputRef.current?.click()}
                    />
                  </div>
                  <button
                    className="link-plain"
                    onClick={() => {
                      void api
                        .deleteTransfer(pending.transferId, pending.uploadToken)
                        .catch(() => undefined);
                      clearPending();
                      setPendingLocal(null);
                    }}
                  >
                    Discard it
                  </button>
                </div>
              </motion.div>
            )}

            <motion.h1 variants={rise} className="hero-title">
              Send files. Nothing else.
            </motion.h1>
            <motion.p variants={rise} className="hero-sub">
              Up to {formatBytes(config.maxTransferSize)} per transfer. No account.
            </motion.p>
            <motion.div variants={rise} className="drop-shell">
              <div className="menu-anchor">
                <button
                  type="button"
                  className={isOver ? 'dropzone is-over' : 'dropzone'}
                  onClick={() => setOpenMenu((v) => (v === 'drop' ? null : 'drop'))}
                >
                  <UploadIcon />
                  <span>
                    <span className="dropzone-title">Drop files or folders here</span>
                    <span className="dropzone-hint" style={{ display: 'block' }}>
                      or <em>browse</em> your computer
                    </span>
                  </span>
                </button>
                <PickerMenu
                  open={openMenu === 'drop'}
                  align="center"
                  onClose={() => setOpenMenu(null)}
                  onPickFiles={() => fileInputRef.current?.click()}
                  onPickFolder={() => folderInputRef.current?.click()}
                />
              </div>
              <div className="drop-footer">
                <span className="meta">Links expire after {pluralize(expiryDays, 'day')}</span>
                <Button disabled>Get a link</Button>
              </div>
            </motion.div>
            <Notice text={error} />
          </motion.div>
        ) : (
          <motion.div key="files" variants={cardSwap} initial="hidden" animate="show" exit="out">
            <div className="card">
              <div className="row-head">
                <span className="title-sm">{pluralize(picked.length, 'file')}</span>
                <span className="meta">{formatBytes(totalBytes)}</span>
              </div>

              <div className="file-list">
                {/* `initial={false}`: rows already present when the card arrives
                    ride in with the card. Only later additions animate. */}
                <AnimatePresence initial={false}>
                  {picked.map((item) => (
                    <motion.div
                      className="file-row"
                      key={item.path}
                      variants={collapsingRow(13)}
                      initial="hidden"
                      animate="show"
                      exit="out"
                    >
                      <span className="ext-badge">{extensionOf(item.path)}</span>
                      <span className="file-name" title={item.path}>
                        {item.path.includes('/') && (
                          <span style={{ color: 'var(--muted)' }}>
                            {item.path.slice(0, item.path.lastIndexOf('/') + 1)}
                          </span>
                        )}
                        {item.path.slice(item.path.lastIndexOf('/') + 1)}
                      </span>
                      <span className="file-size">{formatBytes(item.file.size)}</span>
                      <button
                        className="icon-btn"
                        aria-label={`Remove ${item.path}`}
                        onClick={() => removeAt(item.path)}
                      >
                        <CloseIcon />
                      </button>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>

              <div className="add-row">
                <div className="menu-anchor" style={{ display: 'inline-block' }}>
                  <button onClick={() => setOpenMenu((v) => (v === 'add' ? null : 'add'))}>
                    <PlusIcon color="var(--accent)" />
                    Add more
                  </button>
                  <PickerMenu
                    open={openMenu === 'add'}
                    onClose={() => setOpenMenu(null)}
                    onPickFiles={() => fileInputRef.current?.click()}
                    onPickFolder={() => folderInputRef.current?.click()}
                  />
                </div>
              </div>

              <div className="controls">
                <div>
                  <label className="control-label" htmlFor="expiry">
                    Expires
                  </label>
                  <div className="field">
                    <select
                      id="expiry"
                      value={expiryDays}
                      onChange={(e) => setExpiryDays(Number(e.target.value))}
                    >
                      {expiryOptions.map((days) => (
                        <option key={days} value={days}>
                          {days === 1 ? '1 day' : `${days} days`}
                        </option>
                      ))}
                    </select>
                    <ChevronDownIcon />
                  </div>
                </div>

                <div>
                  <label className="control-label" htmlFor="limit">
                    Download limit
                  </label>
                  <div className="field">
                    <select
                      id="limit"
                      value={downloadLimit === null ? '' : String(downloadLimit)}
                      onChange={(e) =>
                        setDownloadLimit(e.target.value === '' ? null : Number(e.target.value))
                      }
                    >
                      {LIMIT_CHOICES.map((choice) => (
                        <option
                          key={choice.label}
                          value={choice.value === null ? '' : choice.value}
                        >
                          {choice.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDownIcon />
                  </div>
                </div>

                <div className="control--wide">
                  <label className="control-label" htmlFor="password">
                    Password
                  </label>
                  <div className={password ? 'field is-active' : 'field'}>
                    <LockIcon color={password ? 'var(--ink)' : 'var(--muted)'} />
                    <input
                      id="password"
                      type="password"
                      autoComplete="new-password"
                      placeholder="No password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    {password && (
                      <button className="meta" onClick={() => setPassword('')}>
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <Notice text={error} style={{ padding: '0 24px' }} />

              <div className="card-footer">
                <span className="meta">
                  Deleted automatically on {formatShortDate(expiresOn)}
                </span>
                {pendingMatch ? (
                  <Button onClick={resumeInterrupted} disabled={busy}>
                    {busy ? 'Resuming…' : 'Resume upload'}
                  </Button>
                ) : (
                  <Button onClick={start} disabled={busy}>
                    {busy ? 'Starting…' : 'Get a link'}
                  </Button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Page>
  );
}

/* ── inline errors ───────────────────────────────────────────────────────── */

/** Error text that slides in rather than shoving the layout down. */
function Notice({ text, style }: { text: string | null; style?: React.CSSProperties }) {
  return (
    <AnimatePresence initial={false}>
      {text && (
        <motion.p
          className="notice"
          style={{ ...style, overflow: 'hidden' }}
          initial={{ opacity: 0, height: 0, marginTop: 0 }}
          animate={{ opacity: 1, height: 'auto', marginTop: 10 }}
          exit={{ opacity: 0, height: 0, marginTop: 0 }}
          transition={{ duration: duration.base, ease: ease.out }}
        >
          {text}
        </motion.p>
      )}
    </AnimatePresence>
  );
}

/* ── uploading ───────────────────────────────────────────────────────────── */

function UploadProgress({
  snapshot,
  onCancel,
}: {
  snapshot: UploadSnapshot;
  onCancel: () => void;
}) {
  const remaining = snapshot.files.filter((f) => f.state !== 'done').length;

  // Chunks land in bursts, so the raw percent arrives in steps. One spring feeds
  // both the counter and the bar, which keeps them locked to each other and
  // turns the steps into continuous travel.
  const target = useMotionValue(snapshot.percent);
  const sprung = useSpring(target, spring.glide);
  const percentText = useTransform(sprung, (value) => String(Math.floor(value)));
  const barWidth = useTransform(sprung, (value) => `${value}%`);

  useEffect(() => {
    target.set(snapshot.percent);
  }, [snapshot.percent, target]);

  return (
    <div className="card card--pad">
      <div className="progress-head">
        <div>
          <div className="meta" style={{ marginBottom: 6 }}>
            Uploading {pluralize(snapshot.files.length, 'file')}
          </div>
          <div className="progress-percent">
            <motion.span>{percentText}</motion.span>
            <span className="unit">%</span>
          </div>
        </div>
        <div className="progress-right">
          <div>
            {formatBytes(snapshot.uploadedBytes)} of {formatBytes(snapshot.totalBytes)}
          </div>
          <div>{remaining === 0 ? 'finishing up' : formatEta(snapshot.etaSeconds)}</div>
        </div>
      </div>

      <div className="bar">
        <motion.div className="bar-fill bar-fill--live" style={{ width: barWidth }} />
      </div>

      <motion.div
        className="progress-list"
        variants={stagger(0.08, 0.035)}
        initial="hidden"
        animate="show"
      >
        {snapshot.files.map((file) => (
          <motion.div
            className="progress-row"
            key={file.id}
            data-state={file.state}
            variants={rise}
          >
            {file.state === 'done' ? (
              <DrawnCheckIcon />
            ) : (
              <span className={file.state === 'uploading' ? 'ring ring--active' : 'ring'} />
            )}
            <span className="file-name" title={file.path}>
              {file.path}
            </span>
            <span className="file-size">{formatBytes(file.size)}</span>
          </motion.div>
        ))}
      </motion.div>

      <div className="spread" style={{ marginTop: 22 }}>
        <span className="meta">Keep this tab open</span>
        <button className="link-plain" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── upload stopped ──────────────────────────────────────────────────────── */

function UploadStopped({
  snapshot,
  title,
  message,
  busy,
  onRetry,
  onCancel,
}: {
  snapshot: UploadSnapshot;
  title: string;
  message: string;
  busy: boolean;
  onRetry?: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="card card--pad">
      <div className="flag">
        <span className="flag-dot" />
        <span className="flag-text">Upload stopped</span>
      </div>
      <div className="title-md" style={{ marginTop: 0 }}>
        {title}
      </div>
      <p className="sub-sm">{message}</p>
      <div className="bar">
        <div className="bar-fill bar-fill--danger" style={{ width: `${snapshot.percent}%` }} />
      </div>
      <div className="stack">
        {onRetry && (
          <Button full onClick={onRetry} disabled={busy}>
            {busy ? 'Retrying…' : 'Try again'}
          </Button>
        )}
        <button className="link-plain center-text" onClick={onCancel}>
          Cancel this transfer
        </button>
      </div>
    </div>
  );
}

/* ── link ready ──────────────────────────────────────────────────────────── */

function LinkReady({
  info,
  onAnother,
  onDelete,
}: {
  info: TransferInfo;
  onAnother: () => void;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(info.url);
    } catch {
      // Clipboard API needs a secure context; fall back to selecting the text.
      const box = document.getElementById('link-box');
      if (box) {
        const range = document.createRange();
        range.selectNodeContents(box);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /* The payoff of the whole app, so it is the one place given a real sequence:
     the badge lands, the tick draws inside it, then the link and its details
     cascade in behind. Everything else on the site stays quieter than this. */
  return (
    <motion.div
      className="card card--pad"
      variants={stagger(0.06, 0.07)}
      initial="hidden"
      animate="show"
    >
      <motion.div
        className="check-badge"
        variants={{
          hidden: { scale: 0.5, opacity: 0 },
          show: { scale: 1, opacity: 1, transition: spring.soft },
        }}
      >
        <DrawnCheckIcon size={18} color="var(--accent)" delay={0.2} />
      </motion.div>
      <motion.h1 variants={rise} className="title-lg">
        Your link is ready
      </motion.h1>
      <motion.p variants={rise} className="sub">
        {pluralize(info.fileCount, 'file')} · {formatBytes(info.totalSize)} · uploaded just now
      </motion.p>

      <motion.div variants={rise} className="link-row">
        <div className="link-box" id="link-box" title={info.url}>
          {displayUrl(info.url)}
        </div>
        <button className="btn--copy" onClick={copy}>
          {/* Swapped rather than replaced, so the confirmation reads as the
              same control answering back. `.btn--copy` carries a min-width to
              stop the button resizing between the two labels. */}
          <AnimatePresence mode="wait" initial={false}>
            {copied ? (
              <motion.span
                key="copied"
                className="row"
                style={{ gap: 7 }}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: duration.tap, ease: ease.out }}
              >
                <DrawnCheckIcon size={15} color="#fff" strokeWidth={2.5} />
                Copied
              </motion.span>
            ) : (
              <motion.span
                key="copy"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: duration.tap, ease: ease.out }}
              >
                Copy link
              </motion.span>
            )}
          </AnimatePresence>
        </button>
      </motion.div>

      <motion.div variants={rise} className="summary-grid">
        <div>
          <div className="summary-label">Expires</div>
          <div className="summary-value">{formatLongDate(info.expiresAt)}</div>
        </div>
        <div>
          <div className="summary-label">Password</div>
          <div className="summary-value">{info.hasPassword ? 'On' : 'Off'}</div>
        </div>
        <div>
          <div className="summary-label">Downloads</div>
          <div className="summary-value">
            {info.downloadLimit === null
              ? String(info.downloadCount)
              : `${info.downloadCount} of ${info.downloadLimit}`}
          </div>
        </div>
      </motion.div>

      <motion.div variants={rise} className="card-actions">
        <button className="link-plain" onClick={onAnother}>
          Send another transfer
        </button>
        <button className="link-danger" onClick={onDelete}>
          Delete now
        </button>
      </motion.div>

      <motion.p variants={rise} className="meta" style={{ marginTop: 18 }}>
        Saved to{' '}
        <a
          href="/transfers"
          onClick={(e) => {
            e.preventDefault();
            navigate('/transfers');
          }}
        >
          your transfers
        </a>{' '}
        on this device.
      </motion.p>
    </motion.div>
  );
}
