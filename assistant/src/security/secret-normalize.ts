/**
 * Normalization for secret values at ingestion points.
 *
 * Pasted credentials routinely carry invisible edge whitespace — a trailing
 * newline from a terminal copy, a `\r\n` from a clipboard round-trip — which
 * is then stored verbatim and breaks downstream consumers with hard-to-debug
 * auth failures (e.g. a bearer token stored with a trailing `\n` producing
 * 401 "Invalid bearer token").
 *
 * The rule: trim LEADING/TRAILING whitespace only. Interior whitespace is
 * never modified — the credential store also holds multi-line secrets such as
 * PEM private keys, where interior newlines are load-bearing. Edge-trimming a
 * PEM is harmless; touching its interior would corrupt it.
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
