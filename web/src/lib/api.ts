export interface ApiErrorBody {
  error: string;
  message?: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message ?? humanize(body.error) ?? `Request failed (${status})`);
    this.status = status;
    this.code = body.error ?? 'error';
    this.body = body;
  }
}

function humanize(code: string | undefined): string | undefined {
  switch (code) {
    case 'not_found':
      return 'That link does not exist.';
    case 'expired':
      return 'This link has expired.';
    case 'limit_reached':
      return 'This transfer has reached its download limit.';
    case 'storage_full':
      return 'The server is out of space for new transfers.';
    case 'payload_too_large':
      return 'That upload chunk was rejected as too large.';
    case 'unauthorized':
      return 'Please sign in again.';
    default:
      return undefined;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError(0, { error: 'network', message: 'No connection to the server.' });
  }

  if (res.status === 204) return undefined as T;

  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const body = isJson ? await res.json().catch(() => ({})) : {};

  if (!res.ok) throw new ApiError(res.status, body as ApiErrorBody);
  return body as T;
}

function postJson<T>(path: string, payload: unknown, init: RequestInit = {}): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: JSON.stringify(payload),
  });
}

/* ── types ───────────────────────────────────────────────────────────────── */

export interface PublicConfig {
  maxTransferSize: number;
  maxFileSize: number;
  maxFileCount: number;
  maxExpiryDays: number;
  defaultExpiryDays: number;
  chunkSize: number;
  publicUrl: string | null;
}

export interface CreatedFile {
  id: string;
  path: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  complete: boolean;
}

export interface CreatedTransfer {
  transferId: string;
  slug: string;
  uploadToken: string;
  url: string;
  expiresAt: number;
  chunkSize: number;
  files: CreatedFile[];
}

export interface TransferStatus {
  transferId: string;
  slug: string;
  status: 'uploading' | 'complete';
  expiresAt: number;
  chunkSize: number;
  files: Array<{
    id: string;
    path: string;
    size: number;
    chunkSize: number;
    chunkCount: number;
    receivedCount: number;
    complete: boolean;
    received: string;
    missing: number[];
  }>;
}

export interface TransferInfo {
  transferId: string;
  slug: string;
  url: string;
  status: 'uploading' | 'complete';
  createdAt: number;
  expiresAt: number;
  expired: boolean;
  totalSize: number;
  fileCount: number;
  hasPassword: boolean;
  downloadLimit: number | null;
  downloadCount: number;
  lastDownloadAt: number | null;
}

export type TreeNode =
  | { type: 'file'; name: string; path: string; size: number; id: string }
  | {
      type: 'dir';
      name: string;
      path: string;
      size: number;
      fileCount: number;
      children: TreeNode[];
    };

export interface Manifest {
  slug: string;
  createdAt: number;
  expiresAt: number;
  totalSize: number;
  fileCount: number;
  downloadLimit: number | null;
  downloadCount: number;
  limitReached: boolean;
  hasPassword: boolean;
  tree: TreeNode[];
  /**
   * Session token for this open page. Present when the server started (or
   * recognised) a session; null when the transfer is fully claimed. Every
   * download from this page carries it, so opening the link once is enough to
   * fetch everything in it.
   */
  accessToken: string | null;
}

export interface AdminSettings {
  maxTransferSize: number;
  maxFileSize: number;
  maxFileCount: number;
  maxExpiryDays: number;
  defaultExpiryDays: number;
  storageQuotaBytes: number;
  incompleteUploadTtlHours: number;
  cleanupIntervalMinutes: number;
}

export interface AdminTransfer {
  id: string;
  slug: string;
  createdAt: number;
  expiresAt: number;
  completedAt: number | null;
  lastDownloadAt: number | null;
  status: 'uploading' | 'complete';
  totalSize: number;
  fileCount: number;
  hasPassword: boolean;
  downloadLimit: number | null;
  downloadCount: number;
  senderIp: string | null;
  expired: boolean;
}

export interface AdminStats {
  transfers: { total: number; active: number; uploading: number; expired: number };
  storage: {
    logicalBytes: number;
    onDiskBytes: number;
    databaseBytes: number;
    blobDir: string;
    dataDir: string;
    configDir: string;
  };
  encryption: { algorithm: string; masterKeySource: 'env' | 'file' };
}

/* ── endpoints ───────────────────────────────────────────────────────────── */

export const api = {
  config: () => request<PublicConfig>('/api/config'),

  createTransfer: (payload: {
    files: Array<{ path: string; size: number }>;
    dirs: string[];
    expiryDays: number;
    password?: string;
    downloadLimit?: number | null;
  }) => postJson<CreatedTransfer>('/api/transfers', payload),

  transferStatus: (id: string, token: string) =>
    request<TransferStatus>(`/api/transfers/${id}/status`, {
      headers: { authorization: `Bearer ${token}` },
    }),

  transferInfo: (id: string, token: string) =>
    request<TransferInfo>(`/api/transfers/${id}/info`, {
      headers: { authorization: `Bearer ${token}` },
    }),

  finalize: (id: string, token: string) =>
    request<TransferInfo & { url: string }>(`/api/transfers/${id}/finalize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }),

  deleteTransfer: (id: string, token: string) =>
    request<{ ok: true }>(`/api/transfers/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }),

  manifest: (slug: string, token?: string | null) =>
    request<Manifest>(`/api/t/${encodeURIComponent(slug)}${token ? `?k=${encodeURIComponent(token)}` : ''}`),

  unlock: (slug: string, password: string) =>
    postJson<{ token: string | null; hasPassword: boolean }>(
      `/api/t/${encodeURIComponent(slug)}/unlock`,
      { password },
    ),

  admin: {
    session: () => request<{ authenticated: boolean; needsSetup: boolean }>('/api/admin/session'),
    setup: (password: string) => postJson<{ ok: true }>('/api/admin/setup', { password }),
    login: (password: string) => postJson<{ ok: true }>('/api/admin/login', { password }),
    logout: () => postJson<{ ok: true }>('/api/admin/logout', {}),
    settings: () =>
      request<{ settings: AdminSettings; expiryDaysCeiling: number }>('/api/admin/settings'),
    saveSettings: (patch: Partial<AdminSettings>) =>
      request<{ settings: AdminSettings; expiryDaysCeiling: number }>('/api/admin/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    changePassword: (currentPassword: string, newPassword: string) =>
      postJson<{ ok: true }>('/api/admin/password', { currentPassword, newPassword }),
    transfers: () => request<{ transfers: AdminTransfer[] }>('/api/admin/transfers'),
    deleteTransfer: (id: string) =>
      request<{ ok: true }>(`/api/admin/transfers/${id}`, { method: 'DELETE' }),
    stats: () => request<AdminStats>('/api/admin/stats'),
    cleanup: () =>
      postJson<{ expired: number; stalled: number; orphans: number; sessions: number }>(
        '/api/admin/cleanup',
        {},
      ),
  },
};

/* ── download URLs (plain links, so the browser handles them natively) ────── */

export function fileDownloadUrl(slug: string, fileId: string, token?: string | null): string {
  const key = token ? `?k=${encodeURIComponent(token)}` : '';
  return `/api/t/${encodeURIComponent(slug)}/file/${encodeURIComponent(fileId)}${key}`;
}

export function zipDownloadUrl(slug: string, folder?: string, token?: string | null): string {
  const params = new URLSearchParams();
  if (folder) params.set('path', folder);
  if (token) params.set('k', token);
  const query = params.toString();
  return `/api/t/${encodeURIComponent(slug)}/zip${query ? `?${query}` : ''}`;
}
