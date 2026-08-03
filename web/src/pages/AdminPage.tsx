import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type AdminSettings,
  type AdminStats,
  type AdminTransfer,
} from '../lib/api';
import { formatBytes, formatLongDate, formatRelativeExpiry } from '../lib/format';
import { Page } from '../components/Layout';
import { Button } from '../components/Button';
import { TrashIcon } from '../components/Icons';
import { navigate } from '../router';

/** Explains the savings figure, including the honest cases where there are none yet. */
function shrinkNote(shrink: AdminStats['shrink']): string {
  if (!shrink.available) return 'libjxl not installed on this server';
  if (!shrink.enabled) return 'turned off in settings';
  if (shrink.filesPending > 0) {
    const done = shrink.filesShrunk > 0 ? `${formatBytes(shrink.savedBytes)} so far · ` : '';
    return `${done}${shrink.filesPending} file${shrink.filesPending === 1 ? '' : 's'} still to check`;
  }
  if (shrink.savedBytes === 0) return 'nothing recompressible stored yet';
  return `${formatBytes(shrink.savedBytes)} freed · ${shrink.filesShrunk} file${shrink.filesShrunk === 1 ? '' : 's'}`;
}

type Gate = 'checking' | 'setup' | 'login' | 'in';

export function AdminPage() {
  const [gate, setGate] = useState<Gate>('checking');

  const check = useCallback(async () => {
    try {
      const session = await api.admin.session();
      setGate(session.authenticated ? 'in' : session.needsSetup ? 'setup' : 'login');
    } catch {
      setGate('login');
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  if (gate === 'checking') {
    return (
      <Page>
        <div className="loading">Loading…</div>
      </Page>
    );
  }

  if (gate === 'in') return <Dashboard onSignedOut={() => setGate('login')} />;

  return (
    <Page>
      <AuthCard mode={gate} onDone={() => setGate('in')} />
    </Page>
  );
}

/* ── login / first-run setup ─────────────────────────────────────────────── */

function AuthCard({ mode, onDone }: { mode: 'setup' | 'login'; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;

    if (mode === 'setup' && password !== confirm) {
      setError('Those two passwords are not the same.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (mode === 'setup') await api.admin.setup(password);
      else await api.admin.login(password);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="state-card" onSubmit={submit}>
      <div className="title-md" style={{ marginTop: 0 }}>
        {mode === 'setup' ? 'Set an admin password' : 'Admin'}
      </div>
      <p className="sub-sm">
        {mode === 'setup'
          ? 'Nobody has claimed this server yet. Pick a password of at least 8 characters.'
          : 'This page manages settings and every transfer on the server.'}
      </p>

      <div className="field field--tall" style={{ marginBottom: 12 }}>
        <input
          type="password"
          autoFocus
          autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      {mode === 'setup' && (
        <div className="field field--tall" style={{ marginBottom: 12 }}>
          <input
            type="password"
            autoComplete="new-password"
            placeholder="Repeat password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
      )}

      <Button full type="submit" disabled={busy}>
        {busy ? 'Working…' : mode === 'setup' ? 'Create password' : 'Sign in'}
      </Button>
      {error && <p className="notice">{error}</p>}
    </form>
  );
}

/* ── dashboard ───────────────────────────────────────────────────────────── */

function Dashboard({ onSignedOut }: { onSignedOut: () => void }) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [transfers, setTransfers] = useState<AdminTransfer[] | null>(null);
  const [ceiling, setCeiling] = useState(30);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [statsRes, transfersRes, settingsRes] = await Promise.all([
        api.admin.stats(),
        api.admin.transfers(),
        api.admin.settings(),
      ]);
      setStats(statsRes);
      setTransfers(transfersRes.transfers);
      setSettings(settingsRes.settings);
      setCeiling(settingsRes.expiryDaysCeiling);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
    }
  }, [onSignedOut]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const flash = (text: string, ok = true): void => {
    setMessage({ text, ok });
    setTimeout(() => setMessage(null), 4000);
  };

  const saveSettings = async (patch: AdminSettings): Promise<void> => {
    setBusy(true);
    try {
      const res = await api.admin.saveSettings(patch);
      setSettings(res.settings);
      setCeiling(res.expiryDaysCeiling);
      flash('Settings saved.');
    } catch (err) {
      flash(err instanceof ApiError ? err.message : 'Could not save.', false);
    } finally {
      setBusy(false);
    }
  };

  const removeTransfer = async (transfer: AdminTransfer): Promise<void> => {
    if (!window.confirm(`Delete ${transfer.slug} and its files? This cannot be undone.`)) return;
    try {
      await api.admin.deleteTransfer(transfer.id);
      setTransfers((current) => current?.filter((t) => t.id !== transfer.id) ?? null);
      void refresh();
    } catch (err) {
      flash(err instanceof ApiError ? err.message : 'Could not delete.', false);
    }
  };

  const runCleanup = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.admin.cleanup();
      flash(
        `Removed ${result.expired} expired, ${result.stalled} abandoned, ${result.orphans} orphaned` +
          `${result.superseded ? `, reclaimed ${result.superseded} superseded` : ''}.`,
      );
      void refresh();
    } catch (err) {
      flash(err instanceof ApiError ? err.message : 'Cleanup failed.', false);
    } finally {
      setBusy(false);
    }
  };

  const action = (
    <div className="row">
      <button className="link-plain" onClick={() => navigate('/')}>
        Back to Fling
      </button>
      <Button
        variant="dark"
        size="sm"
        onClick={async () => {
          await api.admin.logout().catch(() => undefined);
          onSignedOut();
        }}
      >
        Sign out
      </Button>
    </div>
  );

  return (
    <Page action={action} top wide="admin">
      <h1 className="title-lg">Admin</h1>
      <p className="sub-sm" style={{ marginBottom: 24 }}>
        Every transfer on this server, and the limits senders have to stay within.
      </p>

      {message && (
        <p className={message.ok ? 'notice notice--ok' : 'notice'} style={{ marginBottom: 16 }}>
          {message.text}
        </p>
      )}

      {stats && (
        <>
          <div className="admin-grid">
            <div className="stat">
              <div className="stat-label">Active transfers</div>
              <div className="stat-value">{stats.transfers.active}</div>
              <div className="stat-note">
                {stats.transfers.uploading} uploading · {stats.transfers.expired} expired
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Stored on disk</div>
              <div className="stat-value">{formatBytes(stats.storage.onDiskBytes)}</div>
              <div className="stat-note">{formatBytes(stats.storage.logicalBytes)} of file data</div>
            </div>
            <div className="stat">
              <div className="stat-label">Database</div>
              <div className="stat-value">{formatBytes(stats.storage.databaseBytes)}</div>
              <div className="stat-note">{stats.storage.configDir}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Saved losslessly</div>
              <div className="stat-value">
                {stats.shrink.savedBytes > 0
                  ? `${stats.shrink.savedPercent.toFixed(1)}%`
                  : formatBytes(0)}
              </div>
              <div className="stat-note">
                {shrinkNote(stats.shrink)}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Encryption</div>
              <div className="stat-value" style={{ fontSize: 17 }}>
                AES-256-GCM
              </div>
              <div className="stat-note">
                key from {stats.encryption.masterKeySource === 'env' ? 'environment' : 'config file'}
              </div>
            </div>
          </div>

          {stats.shrink.savedBytes > 0 && (
            <div className="notice notice--ok" style={{ marginBottom: 24 }}>
              <strong>
                {formatBytes(stats.shrink.logicalBytes)} of files stored in{' '}
                {formatBytes(stats.shrink.storedBytes)}.
              </strong>{' '}
              {stats.shrink.filesShrunk} file{stats.shrink.filesShrunk === 1 ? '' : 's'} recompressed
              losslessly — every one of them decoded and checked against its original hash before the
              first copy was dropped. Recipients download the exact bytes that were uploaded.
              {stats.shrink.storedBytes < stats.storage.onDiskBytes && (
                <>
                  {' '}
                  Superseded copies are held briefly so downloads already in flight cannot be pulled
                  out from under, so <em>stored on disk</em> catches up after the next cleanup.
                </>
              )}
            </div>
          )}

          <div className="key-warning" style={{ marginBottom: 24 }}>
            <strong>Back up the master key.</strong> Files are stored encrypted in{' '}
            <span className="mono">{stats.storage.blobDir}</span>. Without the key
            {stats.encryption.masterKeySource === 'env'
              ? ' from FLING_MASTER_KEY'
              : ' in master.key'}{' '}
            they cannot be recovered — not by this app, not by anything else.
          </div>
        </>
      )}

      {settings && (
        <SettingsForm
          settings={settings}
          ceiling={ceiling}
          busy={busy}
          onSave={saveSettings}
          onCleanup={runCleanup}
          onFlash={flash}
        />
      )}

      <div className="section">
        <div className="section-head">
          <h2 className="section-title">Transfers</h2>
          <p className="meta">Everything on the server, regardless of which browser sent it.</p>
        </div>
        <div className="section-body" style={{ padding: '16px 0 0' }}>
          {transfers === null ? (
            <div className="loading">Loading…</div>
          ) : transfers.length === 0 ? (
            <div className="loading">No transfers on the server.</div>
          ) : (
            <div className="table-scroll">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Link</th>
                    <th>Size</th>
                    <th>Files</th>
                    <th>Status</th>
                    <th>Expires</th>
                    <th>Downloads</th>
                    <th>Sender</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {transfers.map((t) => (
                    <tr key={t.id} data-expired={t.expired}>
                      <td className="mono">{t.slug}</td>
                      <td>{formatBytes(t.totalSize)}</td>
                      <td>{t.fileCount}</td>
                      <td>
                        {t.expired ? (
                          <span className="pill">Expired</span>
                        ) : t.status === 'uploading' ? (
                          <span className="pill pill--warn">Uploading</span>
                        ) : (
                          <span className="pill pill--active">Active</span>
                        )}
                        {t.hasPassword && (
                          <span className="pill" style={{ marginLeft: 6 }}>
                            Password
                          </span>
                        )}
                      </td>
                      <td title={formatLongDate(t.expiresAt)}>
                        {t.expired ? '—' : formatRelativeExpiry(t.expiresAt)}
                      </td>
                      <td>
                        {t.downloadLimit === null
                          ? t.downloadCount
                          : `${t.downloadCount} of ${t.downloadLimit}`}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {t.senderIp ?? '—'}
                      </td>
                      <td>
                        <button
                          className="icon-btn"
                          aria-label={`Delete ${t.slug}`}
                          onClick={() => removeTransfer(t)}
                        >
                          <TrashIcon />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}

/* ── settings ────────────────────────────────────────────────────────────── */

const GIB = 1024 ** 3;

function SettingsForm({
  settings,
  ceiling,
  busy,
  onSave,
  onCleanup,
  onFlash,
}: {
  settings: AdminSettings;
  ceiling: number;
  busy: boolean;
  onSave: (patch: AdminSettings) => void;
  onCleanup: () => void;
  onFlash: (text: string, ok?: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => toDraft(settings));

  useEffect(() => setDraft(toDraft(settings)), [settings]);

  const set = <K extends keyof ReturnType<typeof toDraft>>(
    key: K,
    value: ReturnType<typeof toDraft>[K],
  ): void => setDraft((current) => ({ ...current, [key]: value }));

  return (
    <>
      <div className="section">
        <div className="section-head">
          <h2 className="section-title">Limits</h2>
          <p className="meta">What senders are allowed to do. Applies to new transfers.</p>
        </div>
        <div className="section-body">
          <div className="settings-grid">
            <Field
              label="Max transfer size (GB)"
              value={draft.maxTransferSize}
              onChange={(v) => set('maxTransferSize', v)}
              hint="Total of all files in one transfer"
            />
            <Field
              label="Max single file (GB)"
              value={draft.maxFileSize}
              onChange={(v) => set('maxFileSize', v)}
              hint="Largest one file may be"
            />
            <Field
              label="Max files per transfer"
              value={draft.maxFileCount}
              onChange={(v) => set('maxFileCount', v)}
              hint="Folders count each file separately"
            />
            <Field
              label="Max expiry (days)"
              value={draft.maxExpiryDays}
              onChange={(v) => set('maxExpiryDays', v)}
              hint={`Hard ceiling is ${ceiling} days`}
            />
            <Field
              label="Default expiry (days)"
              value={draft.defaultExpiryDays}
              onChange={(v) => set('defaultExpiryDays', v)}
              hint="Pre-selected in the send form"
            />
            <Field
              label="Storage quota (GB)"
              value={draft.storageQuotaBytes}
              onChange={(v) => set('storageQuotaBytes', v)}
              hint="0 means no quota"
            />
            <Field
              label="Abandoned upload TTL (hours)"
              value={draft.incompleteUploadTtlHours}
              onChange={(v) => set('incompleteUploadTtlHours', v)}
              hint="Half-finished uploads are swept after this"
            />
            <Field
              label="Cleanup interval (minutes)"
              value={draft.cleanupIntervalMinutes}
              onChange={(v) => set('cleanupIntervalMinutes', v)}
              hint="How often expired files are deleted"
            />
          </div>

          <label className="shrink-toggle">
            <input
              type="checkbox"
              checked={draft.shrinkEnabled}
              onChange={(e) => set('shrinkEnabled', e.target.checked)}
            />
            <span>
              <strong>Shrink stored files losslessly</strong>
              <em>
                Recompresses stored JPEGs in the background, verifying each one decodes back to its
                original bytes before the first copy is removed. Recipients always download exactly
                what was uploaded. Costs some CPU while it works.
              </em>
            </span>
          </label>

          <div className="row" style={{ marginTop: 20 }}>
            <Button size="sm" disabled={busy} onClick={() => onSave(fromDraft(draft))}>
              Save limits
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={onCleanup}>
              Run cleanup now
            </Button>
          </div>
        </div>
      </div>

      <ChangePassword onFlash={onFlash} />
    </>
  );
}

function toDraft(settings: AdminSettings) {
  return {
    maxTransferSize: String(round2(settings.maxTransferSize / GIB)),
    maxFileSize: String(round2(settings.maxFileSize / GIB)),
    maxFileCount: String(settings.maxFileCount),
    maxExpiryDays: String(settings.maxExpiryDays),
    defaultExpiryDays: String(settings.defaultExpiryDays),
    storageQuotaBytes: String(round2(settings.storageQuotaBytes / GIB)),
    incompleteUploadTtlHours: String(settings.incompleteUploadTtlHours),
    cleanupIntervalMinutes: String(settings.cleanupIntervalMinutes),
    shrinkEnabled: settings.shrinkEnabled,
  };
}

function fromDraft(draft: ReturnType<typeof toDraft>): AdminSettings {
  return {
    maxTransferSize: Math.round(Number(draft.maxTransferSize) * GIB),
    maxFileSize: Math.round(Number(draft.maxFileSize) * GIB),
    maxFileCount: Number(draft.maxFileCount),
    maxExpiryDays: Number(draft.maxExpiryDays),
    defaultExpiryDays: Number(draft.defaultExpiryDays),
    storageQuotaBytes: Math.round(Number(draft.storageQuotaBytes) * GIB),
    incompleteUploadTtlHours: Number(draft.incompleteUploadTtlHours),
    cleanupIntervalMinutes: Number(draft.cleanupIntervalMinutes),
    shrinkEnabled: draft.shrinkEnabled,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function Field({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  return (
    <div>
      <label className="control-label">{label}</label>
      <div className="field">
        <input
          type="number"
          min="0"
          step="any"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {hint && (
        <div className="meta" style={{ fontSize: 12, marginTop: 5 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function ChangePassword({ onFlash }: { onFlash: (text: string, ok?: boolean) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await api.admin.changePassword(current, next);
      setCurrent('');
      setNext('');
      onFlash('Admin password changed.');
    } catch (err) {
      onFlash(err instanceof ApiError ? err.message : 'Could not change the password.', false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="section" onSubmit={submit}>
      <div className="section-head">
        <h2 className="section-title">Admin password</h2>
        <p className="meta">
          If FLING_ADMIN_PASSWORD is set in the container, it is re-applied on every restart.
        </p>
      </div>
      <div className="section-body">
        <div className="settings-grid">
          <div>
            <label className="control-label">Current password</label>
            <div className="field">
              <input
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="control-label">New password</label>
            <div className="field">
              <input
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </div>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          type="submit"
          disabled={busy || current.length === 0 || next.length < 8}
          className="admin-submit"
        >
          Change password
        </Button>
      </div>
    </form>
  );
}
