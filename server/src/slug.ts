import { randomInt } from 'node:crypto';

/**
 * Easy to read out over the phone and easy to type: no 0/O, no 1/l/I, no vowels
 * that turn into real words. Slugs look like `8xk2-vq7m`.
 */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'; // 31 chars
const GROUP = 4;
const GROUPS = 2;

export function generateSlug(): string {
  const parts: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let part = '';
    for (let i = 0; i < GROUP; i++) part += ALPHABET[randomInt(ALPHABET.length)];
    parts.push(part);
  }
  return parts.join('-');
}

/**
 * Accepts what a human actually typed: uppercase, stray spaces, a missing hyphen.
 *
 * Deliberately does NOT guess at excluded characters (0/O, 1/l/I). Substituting
 * a lookalike could resolve to somebody else's transfer, which is far worse than
 * showing "link not found" — so a slug containing them simply fails to match.
 */
export function normalizeSlug(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (raw.length !== GROUP * GROUPS) return value.toLowerCase().trim();

  const parts: string[] = [];
  for (let i = 0; i < GROUPS; i++) parts.push(raw.slice(i * GROUP, (i + 1) * GROUP));
  return parts.join('-');
}
