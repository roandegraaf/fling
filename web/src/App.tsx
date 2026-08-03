import { useEffect, useState } from 'react';
import { MotionConfig } from 'motion/react';
import { api, type PublicConfig } from './lib/api';
import { routeFor, usePath } from './router';
import { SendPage } from './pages/SendPage';
import { DownloadPage } from './pages/DownloadPage';
import { HistoryPage } from './pages/HistoryPage';
import { AdminPage } from './pages/AdminPage';

const FALLBACK_CONFIG: PublicConfig = {
  maxTransferSize: 20 * 1024 ** 3,
  maxFileSize: 20 * 1024 ** 3,
  maxFileCount: 5000,
  maxExpiryDays: 30,
  defaultExpiryDays: 7,
  chunkSize: 4 * 1024 * 1024,
  publicUrl: null,
};

export function App() {
  const path = usePath();
  const route = routeFor(path);
  const [config, setConfig] = useState<PublicConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .config()
      .then((value) => {
        if (!cancelled) setConfig(value);
      })
      .catch(() => {
        // The download and admin pages do not need it; sending falls back to
        // sane limits and the server still enforces the real ones.
        if (!cancelled) setConfig(FALLBACK_CONFIG);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.title =
      route.name === 'download'
        ? 'Fling — files for you'
        : route.name === 'admin'
          ? 'Fling — admin'
          : route.name === 'history'
            ? 'Fling — your transfers'
            : 'Fling — send files';
  }, [route.name]);

  // `reducedMotion="user"` drops transform, layout and scale animations while
  // keeping opacity, so the interface still cross-fades rather than snapping.
  // The CSS half of the same switch lives at the bottom of styles.css.
  return <MotionConfig reducedMotion="user">{renderRoute()}</MotionConfig>;

  function renderRoute() {
    if (route.name === 'download') return <DownloadPage slug={route.slug} />;
    if (route.name === 'admin') return <AdminPage />;
    if (!config) return <div className="loading">Loading…</div>;
    if (route.name === 'history') return <HistoryPage />;
    return <SendPage config={config} />;
  }
}
