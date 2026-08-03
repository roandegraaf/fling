/**
 * The server reports received chunks as a base64 bitmap. Computing the missing
 * list here keeps it exact even for a 20 GB file (5120 chunks → 640 bytes),
 * rather than relying on a truncated convenience array.
 */
export function missingFromBitmap(receivedBase64: string, chunkCount: number): number[] {
  let bytes: Uint8Array;
  try {
    const binary = atob(receivedBase64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    // Unreadable bitmap: safest is to re-send everything.
    return Array.from({ length: chunkCount }, (_, i) => i);
  }

  const missing: number[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const byte = bytes[i >> 3] ?? 0;
    if ((byte & (1 << (i & 7))) === 0) missing.push(i);
  }
  return missing;
}

export function allChunks(chunkCount: number): number[] {
  return Array.from({ length: chunkCount }, (_, i) => i);
}
