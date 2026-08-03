import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api, ApiError, type TransferInfo } from '../lib/api';
import {
  listHistory,
  removeHistory,
  clearHistory,
  type HistoryEntry,
} from '../lib/history';
import { displayUrl, formatBytes, formatRelativeExpiry, pluralize } from '../lib/format';
import { Page } from '../components/Layout';
import { Button } from '../components/Button';
import { collapsingRow, duration, ease, rise } from '../lib/motion';
import { navigate } from '../router';

interface Row {
  entry: HistoryEntry;
  live: TransferInfo | null;
  /** The server no longer has it: expired and swept, or deleted. */
  gone: boolean;
}

export function HistoryPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const entries = listHistory();

    if (entries.length === 0) {
      setRows([]);
      return;
    }

    // Sizes and expiry come from localStorage; download counts must come from
    // the server, so refresh each row.
    void Promise.all(
      entries.map(async (entry): Promise<Row> => {
        try {
          const live = await api.transferInfo(entry.transferId, entry.uploadToken);
          return { entry, live, gone: false };
        } catch (err) {
          const gone = err instanceof ApiError && (err.status === 404 || err.status === 403);
          return { entry, live: null, gone };
        }
      }),
    ).then((result) => {
      if (!cancelled) setRows(result);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const copy = async (url: string, id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(id);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      window.prompt('Copy this link', url);
    }
  };

  const forget = (transferId: string): void => {
    removeHistory(transferId);
    setRows((current) => current?.filter((r) => r.entry.transferId !== transferId) ?? null);
  };

  const action = (
    <Button variant="dark" size="sm" onClick={() => navigate('/')}>
      New transfer
    </Button>
  );

  if (rows === null) {
    return (
      <Page action={action} top wide="wide">
        <div className="loading">Loading…</div>
      </Page>
    );
  }

  if (rows.length === 0) {
    return (
      <Page action={action} top wide="wide">
        <motion.div
          variants={rise}
          className="state-card state-card--center"
          style={{ marginTop: 60 }}
        >
          <div className="title-md" style={{ marginTop: 0 }}>
            No transfers yet
          </div>
          <p className="sub-sm">Everything you send from this browser shows up here.</p>
          <Button variant="dark" full onClick={() => navigate('/')}>
            New transfer
          </Button>
        </motion.div>
      </Page>
    );
  }

  return (
    <Page action={action} top wide="wide">
      <motion.h1 variants={rise} className="title-lg">
        Your transfers
      </motion.h1>
      <motion.p variants={rise} className="sub-sm" style={{ marginBottom: 24 }}>
        Kept on this device only. Clearing your browser clears this list.
      </motion.p>

      <motion.div variants={rise} className="card">
        <div className="table-head">
          <span>Transfer</span>
          <span>Size</span>
          <span>Expires</span>
          <span>Downloads</span>
          <span />
        </div>

        {/* Rows cascade in behind the card, and a removed row collapses so the
            ones under it slide up instead of jumping. */}
        <AnimatePresence>
          {rows.map(({ entry, live, gone }, index) => {
            const expired = gone || (live?.expired ?? entry.expiresAt <= Date.now());
            const downloads = live
              ? live.downloadLimit === null
                ? String(live.downloadCount)
                : `${live.downloadCount} of ${live.downloadLimit}`
              : '—';

            return (
              <motion.div
                className="table-row"
                key={entry.transferId}
                data-expired={expired}
                variants={collapsingRow(16, Math.min(index, 10) * 0.03)}
                initial="hidden"
                animate="show"
                exit="out"
              >
                <div style={{ minWidth: 0 }}>
                  <div className="table-primary">
                    {pluralize(entry.fileCount, 'file')}
                    {entry.firstName ? ` · ${entry.firstName}` : ''}
                  </div>
                  <div className="table-sub">
                    {expired ? 'no longer available' : displayUrl(entry.url)}
                  </div>
                </div>
                <span className="table-cell">{formatBytes(entry.totalSize)}</span>
                <span className="table-cell">
                  {expired ? 'Expired' : formatRelativeExpiry(live?.expiresAt ?? entry.expiresAt)}
                </span>
                <span className="table-cell">{downloads}</span>
                <span className="table-actions">
                  {expired ? (
                    <button className="link-plain" onClick={() => forget(entry.transferId)}>
                      Remove
                    </button>
                  ) : (
                    <button
                      className="link-accent"
                      onClick={() => copy(live?.url ?? entry.url, entry.transferId)}
                    >
                      {copied === entry.transferId ? 'Copied' : 'Copy'}
                    </button>
                  )}
                </span>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </motion.div>

      <div className="spread" style={{ marginTop: 18 }}>
        <span className="meta">
          Only this browser knows about these. The admin page lists every transfer on the server.
        </span>
        <button
          className="link-plain"
          onClick={() => {
            if (window.confirm('Remove every entry from this list? The files stay on the server.')) {
              clearHistory();
              setRows([]);
            }
          }}
        >
          Clear list
        </button>
      </div>
    </Page>
  );
}
