import type { FastifyReply, FastifyRequest } from 'fastify';

export interface FriendlyError {
  status: number;
  code: string;
  title: string;
  message: string;
  /** Optional link back into the app. */
  action?: { href: string; label: string };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Downloads are plain links, so a failure lands in the address bar rather than
 * in fetch(). Serving raw JSON there is unreadable — this renders the same state
 * card the SPA would show. Anything that is not a browser navigation still gets
 * JSON, so the SPA's own fetches are unaffected.
 */
function wantsHtml(req: FastifyRequest): boolean {
  const accept = String(req.headers.accept ?? '');
  return accept.includes('text/html');
}

function renderPage(error: FriendlyError): string {
  const action = error.action
    ? `<a class="btn" href="${escapeHtml(error.action.href)}">${escapeHtml(error.action.label)}</a>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Fling — ${escapeHtml(error.title)}</title>
<link rel="stylesheet" href="/fonts/fonts.css">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='11' fill='%23E87722'/%3E%3C/svg%3E">
<style>
  *,*::before,*::after{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:#FBF6F0;color:#1A1A1A;
       font-family:'Be Vietnam Pro',system-ui,-apple-system,'Segoe UI',sans-serif;
       -webkit-font-smoothing:antialiased;display:flex;flex-direction:column}
  header{height:76px;display:flex;align-items:center;padding:0 40px;gap:9px}
  .dot{width:11px;height:11px;border-radius:999px;background:#E87722}
  .name{font-family:'Outfit',system-ui,sans-serif;font-weight:700;font-size:19px;
        letter-spacing:-0.01em;color:#1A1A1A;text-decoration:none}
  main{flex:1;display:flex;align-items:center;justify-content:center;padding:0 20px 60px}
  .card{width:100%;max-width:380px;background:#fff;border:1px solid #E7E2DB;
        border-radius:16px;padding:26px}
  h1{font-family:'Outfit',system-ui,sans-serif;font-weight:700;font-size:21px;
     color:#1A1A1A;margin:14px 0 5px;line-height:1.2}
  p{margin:0 0 18px;font-size:14px;line-height:1.55;color:#6B6B6B}
  .btn{display:flex;align-items:center;justify-content:center;height:46px;
       border-radius:999px;border:1px solid #1A1A1A;color:#1A1A1A;font-weight:500;
       font-size:15px;text-decoration:none}
  .btn:hover{background:rgba(0,0,0,.04)}
  @media (max-width:720px){header{height:56px;padding:0 20px}main{padding:8px 20px 24px;align-items:flex-start}}
</style>
</head>
<body>
  <header><span class="dot"></span><a class="name" href="/">Fling</a></header>
  <main>
    <div class="card">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6B6B6B"
           stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="8"></circle><path d="M12 8v4l2.5 2"></path>
      </svg>
      <h1>${escapeHtml(error.title)}</h1>
      <p>${escapeHtml(error.message)}</p>
      ${action}
    </div>
  </main>
</body>
</html>`;
}

export function sendFriendly(
  req: FastifyRequest,
  reply: FastifyReply,
  error: FriendlyError,
): FastifyReply {
  reply.code(error.status);

  if (wantsHtml(req)) {
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(renderPage(error));
  }

  return reply.send({ error: error.code, message: error.message });
}

/* ── the errors a recipient can actually hit ─────────────────────────────── */

export const ERRORS = {
  notFound: (): FriendlyError => ({
    status: 404,
    code: 'not_found',
    title: 'This link does not exist',
    message:
      'Check the address for typos — Fling links look like 8xk2-vq7m. It may also have been deleted by the sender.',
    action: { href: '/', label: 'Send your own files' },
  }),

  expired: (): FriendlyError => ({
    status: 410,
    code: 'expired',
    title: 'This link has expired',
    message: 'The files have been deleted from the server. Ask the sender to send them again.',
    action: { href: '/', label: 'Send your own files' },
  }),

  limitReached: (slug: string): FriendlyError => ({
    status: 410,
    code: 'limit_reached',
    title: 'This transfer has been fully claimed',
    message:
      'It reached the number of downloads the sender allowed. Ask them to send it again if you still need the files.',
    action: { href: `/${slug}`, label: 'Back to the transfer' },
  }),

  sessionExpired: (slug: string): FriendlyError => ({
    status: 401,
    code: 'session_expired',
    title: 'Open the transfer page first',
    message:
      'This download link needs an open transfer page. Go back to the transfer and start the download from there.',
    action: { href: `/${slug}`, label: 'Open the transfer' },
  }),

  passwordRequired: (slug: string): FriendlyError => ({
    status: 401,
    code: 'password_required',
    title: 'This transfer is protected',
    message: 'Open the transfer page and enter the password the sender gave you.',
    action: { href: `/${slug}`, label: 'Open the transfer' },
  }),

  fileMissing: (slug: string): FriendlyError => ({
    status: 404,
    code: 'file_not_found',
    title: 'That file is not part of this transfer',
    message: 'It may have been removed. Open the transfer to see what is still there.',
    action: { href: `/${slug}`, label: 'Open the transfer' },
  }),

  zipFailed: (slug: string): FriendlyError => ({
    status: 500,
    code: 'zip_failed',
    title: 'The archive could not be built',
    message: 'Something went wrong while packing these files. Try again, or download them one by one.',
    action: { href: `/${slug}`, label: 'Back to the transfer' },
  }),
} as const;
