export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  // A round number reads as "20 GB", not "20.0 GB".
  const rounded =
    value >= 100
      ? String(Math.round(value))
      : value.toFixed(value >= 10 ? 1 : 2).replace(/\.?0+$/, '');
  return `${rounded} ${units[unit]}`;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** "10 Aug" */
export function formatShortDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "10 Aug 2026" */
export function formatLongDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "10 August" */
export function formatFullMonth(ms: number): string {
  const d = new Date(ms);
  const full = d.toLocaleString('en-GB', { month: 'long' });
  return `${d.getDate()} ${full}`;
}

/** "in 7 days" / "in 12 hours" / "Expired" */
export function formatRelativeExpiry(expiresAt: number, now = Date.now()): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'Expired';

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `in ${Math.max(1, minutes)} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.floor(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

/** "about 3 minutes left" */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'calculating…';
  if (seconds < 10) return 'almost done';
  if (seconds < 90) return `about ${Math.round(seconds / 5) * 5} seconds left`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'} left`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return `about ${hours} hour${hours === 1 ? '' : 's'} left`;
  return `about ${hours}h ${rest}m left`;
}

/** The badge shown next to a filename: MOV, PDF, ZIP … */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'FILE';
  const ext = name.slice(dot + 1).toUpperCase();
  return ext.length > 4 ? ext.slice(0, 4) : ext;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Strips the scheme so a link reads as `fling.example.com/8xk2-vq7m`. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
