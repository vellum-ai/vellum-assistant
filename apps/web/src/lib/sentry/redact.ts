/**
 * PII scrubbing for browser Sentry events.
 *
 * Mirrors `assistant/src/instrument.ts` so the daemon and the browser
 * apply the same redaction policy before transmit. Patterns match
 * email addresses, credit-card numbers, and US SSNs; values are
 * replaced with `[REDACTED]` in-place.
 *
 * Reference: https://docs.sentry.io/platforms/javascript/data-management/sensitive-data/
 */

const PII_PATTERNS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(?:\d{4}[- ]){3}\d{1,7}\b|\b\d{13,19}\b/g,
  /\b\d{3}-\d{2}-\d{4}\b/g,
];

export function redactString(value: string): string {
  let result = value;
  for (const pattern of PII_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

export function redactObject(obj: unknown): unknown {
  if (typeof obj === "string") return redactString(obj);
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (obj != null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      out[key] = redactObject(val);
    }
    return out;
  }
  return obj;
}
