import type { FastifyRequest } from 'fastify';
import { PUBLIC_URL } from './env.ts';

/**
 * The URL a recipient should see. FLING_PUBLIC_URL wins when set; otherwise it
 * is derived from the request, honouring X-Forwarded-* so links built behind a
 * reverse proxy point at the public hostname rather than the container.
 */
export function baseUrl(req: FastifyRequest): string {
  if (PUBLIC_URL) return PUBLIC_URL;

  const firstOf = (value: string | string[] | undefined): string | undefined => {
    if (!value) return undefined;
    const raw = Array.isArray(value) ? value[0] : value;
    return raw.split(',')[0]?.trim() || undefined;
  };

  const proto = firstOf(req.headers['x-forwarded-proto']) ?? req.protocol ?? 'http';
  const host = firstOf(req.headers['x-forwarded-host']) ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

export function publicUrlFor(req: FastifyRequest, slug: string): string {
  return `${baseUrl(req)}/${slug}`;
}
