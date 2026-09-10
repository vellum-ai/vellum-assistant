export const MALFORMED_USTAR_SIZE = "malformed tar size field";

/** Encode large files using the GNU base-256 extension beyond ustar's 8 GiB limit. */
export function writeUstarSizeField(header: Uint8Array, size: number): void {
  if (header.length < 136 || !Number.isSafeInteger(size) || size < 0) {
    throw new Error(MALFORMED_USTAR_SIZE);
  }
  const raw = header.subarray(124, 136);
  raw.fill(0);
  if (size <= 0o77777777777) {
    raw.set(new TextEncoder().encode(size.toString(8).padStart(11, "0")));
    return;
  }
  let remaining = BigInt(size);
  for (let i = raw.length - 1; i > 0; i--) {
    raw[i] = Number(remaining & 255n);
    remaining >>= 8n;
  }
  raw[0] = 0x80;
}

/**
 * Parse the ustar `size` field (bytes 124-135), including GNU base-256.
 * Rejects unsafe and negative values so a crafted header
 * cannot walk the archive cursor backwards.
 */
export function parseUstarSizeField(header: Uint8Array): number {
  if (header.length < 136) {
    throw new Error(MALFORMED_USTAR_SIZE);
  }
  const raw = header.subarray(124, 136);
  if (raw[0] & 0x80) {
    if (raw[0] !== 0x80) {
      throw new Error(MALFORMED_USTAR_SIZE);
    }
    let size = 0;
    for (const byte of raw.subarray(1)) {
      size = size * 256 + byte;
    }
    if (!Number.isSafeInteger(size)) {
      throw new Error(MALFORMED_USTAR_SIZE);
    }
    return size;
  }
  let end = 0;
  while (end < raw.length && raw[end] !== 0) {
    end++;
  }
  const sizeStr = new TextDecoder().decode(raw.subarray(0, end)).trim();
  const size = sizeStr ? Number.parseInt(sizeStr, 8) : 0;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(MALFORMED_USTAR_SIZE);
  }
  return size;
}
