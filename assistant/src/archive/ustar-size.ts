export const MALFORMED_USTAR_SIZE = "malformed tar size field";

/**
 * Parse the ustar `size` field (bytes 124-135, octal, NUL or space
 * terminated). Rejects non-finite and negative values so a crafted header
 * cannot walk the archive cursor backwards.
 */
export function parseUstarSizeField(header: Uint8Array): number {
  if (header.length < 136) {
    throw new Error(MALFORMED_USTAR_SIZE);
  }
  const raw = header.subarray(124, 136);
  let end = 0;
  while (end < raw.length && raw[end] !== 0) {
    end++;
  }
  const sizeStr = new TextDecoder().decode(raw.subarray(0, end)).trim();
  const size = sizeStr ? Number.parseInt(sizeStr, 8) : 0;
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(MALFORMED_USTAR_SIZE);
  }
  return size;
}
