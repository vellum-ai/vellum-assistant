/**
 * Normalization for secret values at ingestion points.
 *
 * Pasted credentials routinely carry invisible edge newlines — a trailing
 * `\n` from a terminal copy, a `\r\n` from a clipboard round-trip — which
 * are then stored verbatim and break downstream consumers with hard-to-debug
 * auth failures (e.g. a bearer token stored with a trailing `\n` producing
 * 401 "Invalid bearer token").
 *
 * The rules:
 *  - Trim ONLY carriage returns and line feeds, and only at the edges.
 *    Edge CR/LF is always a paste artifact: a newline cannot be typed into a
 *    single-line secret field. Edge spaces/tabs are preserved — the vault
 *    also stores passwords (e.g. for browser credential fill), and a real
 *    password may legitimately begin or end with a space.
 *  - Never modify interior whitespace. The store holds multi-line secrets
 *    such as PEM private keys, where interior newlines are load-bearing.
 */

const EDGE_NEWLINES = /^[\r\n]+|[\r\n]+$/g;

/**
 * Trim leading and trailing newline characters (`\r`, `\n`) from a secret
 * value. Spaces, tabs, and all interior whitespace are preserved.
 * Idempotent: already-clean values are returned unchanged.
 */
export function normalizeSecretValue(value: string): string {
  return value.replace(EDGE_NEWLINES, "");
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
