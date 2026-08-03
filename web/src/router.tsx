import { useEffect, useState } from 'react';

const NAVIGATE_EVENT = 'fling:navigate';

export function navigate(to: string, replace = false): void {
  if (replace) window.history.replaceState({}, '', to);
  else window.history.pushState({}, '', to);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
  window.scrollTo(0, 0);
}

export function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const sync = (): void => setPath(window.location.pathname);
    window.addEventListener('popstate', sync);
    window.addEventListener(NAVIGATE_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(NAVIGATE_EVENT, sync);
    };
  }, []);

  return path;
}

export type Route =
  | { name: 'send' }
  | { name: 'history' }
  | { name: 'admin' }
  | { name: 'download'; slug: string };

const SLUG_RE = /^[23456789abcdefghjkmnpqrstuvwxyz]{4}-[23456789abcdefghjkmnpqrstuvwxyz]{4}$/;

export function routeFor(path: string): Route {
  const clean = path.replace(/\/+$/, '') || '/';

  if (clean === '/' || clean === '') return { name: 'send' };
  if (clean === '/transfers') return { name: 'history' };
  if (clean === '/admin') return { name: 'admin' };

  const segment = clean.slice(1).toLowerCase();
  if (!segment.includes('/')) {
    // Anything else that looks like a link is treated as a slug; the server is
    // the authority on whether it exists.
    const normalized =
      segment.length === 8 && !segment.includes('-')
        ? `${segment.slice(0, 4)}-${segment.slice(4)}`
        : segment;
    if (SLUG_RE.test(normalized)) return { name: 'download', slug: normalized };
    return { name: 'download', slug: segment };
  }

  return { name: 'send' };
}
