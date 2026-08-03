const TYPES: Record<string, string> = {
  aac: 'audio/aac',
  ai: 'application/postscript',
  avi: 'video/x-msvideo',
  avif: 'image/avif',
  bmp: 'image/bmp',
  css: 'text/css; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  eps: 'application/postscript',
  flac: 'audio/flac',
  gif: 'image/gif',
  gz: 'application/gzip',
  heic: 'image/heic',
  htm: 'text/html; charset=utf-8',
  html: 'text/html; charset=utf-8',
  ico: 'image/vnd.microsoft.icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  m4a: 'audio/mp4',
  md: 'text/markdown; charset=utf-8',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  png: 'image/png',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  psd: 'image/vnd.adobe.photoshop',
  rar: 'application/vnd.rar',
  svg: 'image/svg+xml',
  tar: 'application/x-tar',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  txt: 'text/plain; charset=utf-8',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xml: 'application/xml',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
};

export function mimeFor(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return TYPES[filename.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

/** RFC 5987 Content-Disposition that survives non-ASCII filenames. */
export function contentDisposition(filename: string, inline = false): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
