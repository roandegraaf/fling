import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  api,
  ApiError,
  fileDownloadUrl,
  zipDownloadUrl,
  type Manifest,
  type TreeNode,
} from '../lib/api';
import { extensionOf, formatBytes, formatFullMonth, pluralize } from '../lib/format';
import { HeaderLink, Page } from '../components/Layout';
import {
  ChevronRightIcon,
  ClockIcon,
  DownloadIcon,
  FolderIcon,
  LockIcon,
} from '../components/Icons';
import { Button } from '../components/Button';
import { duration, ease, rise } from '../lib/motion';
import { navigate } from '../router';

type State =
  | { kind: 'loading' }
  | { kind: 'locked'; error?: string }
  | { kind: 'ready'; manifest: Manifest }
  | { kind: 'expired' }
  | { kind: 'missing' };

const tokenKey = (slug: string): string => `fling.grant.${slug}`;

function readToken(slug: string): string | null {
  try {
    return sessionStorage.getItem(tokenKey(slug));
  } catch {
    return null;
  }
}

function writeToken(slug: string, token: string): void {
  try {
    sessionStorage.setItem(tokenKey(slug), token);
  } catch {
    /* ignore */
  }
}

export function DownloadPage({ slug }: { slug: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [token, setToken] = useState<string | null>(() => readToken(slug));

  // Loading the manifest is what spends a download against the limit, so it must
  // happen exactly once per slug+token — not twice under StrictMode.
  const loadedKey = useRef<string | null>(null);

  const load = useCallback(
    async (grant: string | null) => {
      try {
        const manifest = await api.manifest(slug, grant);
        // The server hands back a session token; persisting it means every file,
        // folder zip and download-all from this page is covered by the one open.
        // It is deliberately not put into React state: each call mints a freshly
        // signed token, so feeding it back into the effect's deps would reload
        // the manifest forever. Rendering reads it off the manifest instead.
        if (manifest.accessToken) writeToken(slug, manifest.accessToken);
        setState({ kind: 'ready', manifest });
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.status === 401) return setState({ kind: 'locked' });
          if (err.status === 410) return setState({ kind: 'expired' });
          if (err.status === 404) return setState({ kind: 'missing' });
        }
        setState({ kind: 'missing' });
      }
    },
    [slug],
  );

  useEffect(() => {
    const key = `${slug}:${token ?? ''}`;
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    void load(token);
  }, [load, slug, token]);

  const header = <HeaderLink to="/">Send your own files</HeaderLink>;

  if (state.kind === 'loading') {
    return (
      <Page action={header}>
        <div className="loading">Loading…</div>
      </Page>
    );
  }

  if (state.kind === 'locked') {
    return (
      <Page action={header}>
        <PasswordGate
          slug={slug}
          onUnlocked={(grant) => {
            if (grant) writeToken(slug, grant);
            setToken(grant);
            setState({ kind: 'loading' });
          }}
        />
      </Page>
    );
  }

  if (state.kind === 'expired') {
    return (
      <Page action={header}>
        <motion.div variants={rise} className="state-card">
          <ClockIcon />
          <div className="title-md">This link has expired</div>
          <p className="sub-sm">The files were deleted. Ask the sender to send them again.</p>
          <Button variant="outline" full onClick={() => navigate('/')}>
            Send your own files
          </Button>
        </motion.div>
      </Page>
    );
  }

  if (state.kind === 'missing') {
    return (
      <Page action={header}>
        <motion.div variants={rise} className="state-card">
          <ClockIcon />
          <div className="title-md">This link does not exist</div>
          <p className="sub-sm">
            Check the address for typos — links look like <span className="mono">8xk2-vq7m</span>.
          </p>
          <Button variant="outline" full onClick={() => navigate('/')}>
            Send your own files
          </Button>
        </motion.div>
      </Page>
    );
  }

  return (
    <Page action={header}>
      <TransferView manifest={state.manifest} token={token} />
    </Page>
  );
}

/* ── password gate ───────────────────────────────────────────────────────── */

function PasswordGate({
  slug,
  onUnlocked,
}: {
  slug: string;
  onUnlocked: (token: string | null) => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || password.length === 0) return;

    setBusy(true);
    setError(null);
    try {
      const { token } = await api.unlock(slug, password);
      onUnlocked(token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not check that password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.form variants={rise} className="state-card" onSubmit={submit}>
      <LockIcon size={20} />
      <div className="title-md">This transfer is protected</div>
      <p className="sub-sm">Ask the sender for the password.</p>
      <div className="field field--tall" style={{ marginBottom: 12 }}>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <Button full type="submit" disabled={busy}>
        {busy ? 'Checking…' : 'Unlock'}
      </Button>
      <AnimatePresence initial={false}>
        {error && (
          <motion.p
            className="notice"
            style={{ overflow: 'hidden' }}
            initial={{ opacity: 0, height: 0, marginTop: 0 }}
            animate={{ opacity: 1, height: 'auto', marginTop: 10 }}
            exit={{ opacity: 0, height: 0, marginTop: 0 }}
            transition={{ duration: duration.base, ease: ease.out }}
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </motion.form>
  );
}

/* ── recipient view ──────────────────────────────────────────────────────── */

function TransferView({ manifest, token }: { manifest: Manifest; token: string | null }) {
  // A session token is what makes downloads work. Holding one means this page
  // may download everything in the transfer, even if opening it consumed the
  // last allowed download.
  const canDownload = manifest.accessToken !== null;
  const grant = manifest.accessToken ?? token;

  const downloadsLeft =
    manifest.downloadLimit === null
      ? null
      : Math.max(0, manifest.downloadLimit - manifest.downloadCount);

  return (
    <motion.div variants={rise} className="card">
      <div style={{ padding: '32px 32px 22px' }}>
        <h1 className="title-lg">{pluralize(manifest.fileCount, 'file')} for you</h1>
        <p className="sub" style={{ marginBottom: 0 }}>
          {formatBytes(manifest.totalSize)} · available until {formatFullMonth(manifest.expiresAt)}
        </p>
      </div>

      <div className="tree">
        <NodeList
          nodes={manifest.tree}
          depth={0}
          slug={manifest.slug}
          token={grant}
          disabled={!canDownload}
        />
      </div>

      <div
        style={{
          padding: '24px 32px 28px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <span className="meta">
          {!canDownload ? (
            'This transfer has been fully claimed — ask the sender to send it again.'
          ) : downloadsLeft === null ? (
            'No download limit'
          ) : (
            <>
              {downloadsLeft} of {manifest.downloadLimit} downloads left
              <br />
              <span style={{ color: 'var(--faint)' }}>
                Take as much as you like — it all counts as one.
              </span>
            </>
          )}
        </span>
        {canDownload ? (
          <Button
            size="tall"
            href={zipDownloadUrl(manifest.slug, undefined, grant)}
            icon={<DownloadIcon size={15} color="#fff" />}
          >
            Download all
          </Button>
        ) : (
          <Button disabled>Download all</Button>
        )}
      </div>
    </motion.div>
  );
}

/** Rows cascade rather than appearing all at once, so an opening folder reads
    as unfolding. Capped so a 300-row folder does not take eight seconds. */
const rowReveal = (index: number) => ({
  initial: { opacity: 0, y: -4 },
  animate: { opacity: 1, y: 0 },
  transition: {
    duration: duration.base,
    ease: ease.out,
    delay: Math.min(index, 12) * 0.025,
  },
});

/**
 * Renders a folder's children, capping how many appear at once. A 5000-file
 * transfer would otherwise mount 5000 rows on load.
 */
const PAGE_SIZE = 300;

function NodeList({
  nodes,
  depth,
  slug,
  token,
  disabled,
}: {
  nodes: TreeNode[];
  depth: number;
  slug: string;
  token: string | null;
  disabled: boolean;
}) {
  const [shown, setShown] = useState(PAGE_SIZE);
  const visible = nodes.length > shown ? nodes.slice(0, shown) : nodes;

  return (
    <>
      {visible.map((node, index) => (
        <TreeRow
          key={node.path}
          node={node}
          index={index}
          depth={depth}
          slug={slug}
          token={token}
          disabled={disabled}
        />
      ))}
      {nodes.length > shown && (
        <div className="tree-row" style={{ paddingLeft: 32 + depth * 18 }}>
          <span className="tree-spacer" />
          <button className="link-accent" onClick={() => setShown((n) => n + PAGE_SIZE * 3)}>
            Show more — {nodes.length - shown} still hidden
          </button>
        </div>
      )}
    </>
  );
}

function TreeRow({
  node,
  index,
  depth,
  slug,
  token,
  disabled,
}: {
  node: TreeNode;
  index: number;
  depth: number;
  slug: string;
  token: string | null;
  disabled: boolean;
}) {
  // Top level starts open so the contents are visible without a click.
  const [open, setOpen] = useState(depth === 0);
  const indent = 32 + depth * 18;

  if (node.type === 'file') {
    return (
      <motion.div {...rowReveal(index)} className="tree-row" style={{ paddingLeft: indent }}>
        <span className="tree-spacer" />
        <span className="ext-badge">{extensionOf(node.name)}</span>
        <span className="tree-name" title={node.name}>
          {node.name}
        </span>
        <span className="file-size">{formatBytes(node.size)}</span>
        {disabled ? (
          <span className="tree-action" style={{ color: 'var(--faint)' }}>
            <DownloadIcon size={15} />
          </span>
        ) : (
          <a
            className="tree-action"
            href={fileDownloadUrl(slug, node.id, token)}
            aria-label={`Download ${node.name}`}
          >
            <DownloadIcon size={15} />
          </a>
        )}
      </motion.div>
    );
  }

  return (
    <>
      <motion.div {...rowReveal(index)} className="tree-row" style={{ paddingLeft: indent }}>
        <button
          className="tree-toggle"
          data-open={open}
          aria-expanded={open}
          aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRightIcon />
        </button>
        <FolderIcon />
        <span className="tree-name tree-name--dir" title={node.path}>
          {node.name}
        </span>
        <span className="tree-count">
          {pluralize(node.fileCount, 'file')} · {formatBytes(node.size)}
        </span>
        {disabled ? (
          <span className="tree-action" style={{ color: 'var(--faint)' }}>
            .zip
          </span>
        ) : (
          <a className="tree-action" href={zipDownloadUrl(slug, node.path, token)}>
            <DownloadIcon size={14} />
            .zip
          </a>
        )}
      </motion.div>
      {open && (
        <NodeList
          nodes={node.children}
          depth={depth + 1}
          slug={slug}
          token={token}
          disabled={disabled}
        />
      )}
    </>
  );
}
