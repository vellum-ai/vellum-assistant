/**
 * Normalization for secret values at ingestion points.
 *
 * Pasted credentials routinely carry invisible edge whitespace — a trailing
 * newline from a terminal copy, a `\r\n` from a clipboard round-trip, stray
 * spaces from a PDF copy — which is then stored verbatim and breaks
 * downstream consumers with hard-to-debug auth failures (e.g. a bearer token
 * stored with a trailing `\n` producing 401 "Invalid bearer token").
 *
 * The rules:
 *  - Trim ALL leading/trailing whitespace (spaces, tabs, `\r`, `\n`).
 *    Deliberate decision: edge whitespace in stored secrets is not
 *    supported. Paste artifacts with edge whitespace vastly outnumber
 *    legitimately edge-spaced passwords, and most auth systems trim edge
 *    whitespace themselves. If a real need for an edge-spaced secret ever
 *    appears, add an explicit opt-out at that ingestion point — do not
 *    weaken this default.
 *  - Never modify interior whitespace. The store holds multi-line secrets
 *    such as PEM private keys, where interior newlines are load-bearing.
 *    Edge-trimming a PEM is harmless; touching its interior would corrupt it.
 */

/**
 * Trim leading and trailing whitespace (spaces, tabs, `\r`, `\n`, and other
 * Unicode whitespace) from a secret value. Interior whitespace is preserved.
 * Idempotent: already-clean values are returned unchanged.
 */
export function normalizeSecretValue(value: string): string {
  return value.trim();
}

/**
 * True when a (normalized) value still contains interior whitespace.
 *
 * Expected for multi-line secrets (PEM keys, service-account JSON); unexpected
 * for API tokens. Callers may use this to log a non-fatal, content-free
 * warning. Never log the value itself.
 */
export function hasInteriorWhitespace(value: string): boolean {
  return /\s/.test(value);
}
