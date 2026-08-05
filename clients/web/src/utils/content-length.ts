/**
 * Response payload size for fetch diagnostics.
 */

/**
 * Byte size of a response body read from its `content-length` header, or null
 * when the header is absent, blank, or not a finite number.
 *
 * Diagnostics record the result verbatim, so an unusable header has to stay
 * distinguishable from a real size: `Number("")` is 0 (a plausible body size)
 * and `Number("abc")` is NaN (which JSON-stringifies to null, so it reads back
 * exactly like an absent header). Both collapse to an explicit null here.
 */
export function readContentLength(response: Response): number | null {
  const header = response.headers.get("content-length");
  if (header === null || header.trim() === "") {
    return null;
  }
  const bytes = Number(header);
  return Number.isFinite(bytes) ? bytes : null;
}
