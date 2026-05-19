/**
 * Shared redaction utilities for perception payloads.
 *
 * Single source of truth for the patterns used by:
 *   - `PerceptionInterpreter` when sanitizing LLM-produced text
 *   - `PerceptionRelevanceGate` when sanitizing reason + proactive wake hints
 *   - HTTP publish-route defense-in-depth on caller-provided fields
 *
 * The producer is always expected to redact at capture time, but every
 * crossing of a process boundary re-applies these patterns so a buggy or
 * compromised producer can never leak raw secrets into the daemon's event
 * hub, memory buffer, or persisted memory.
 */

const REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    replacement: "[redacted-email]",
  },
  {
    pattern: /\bhttps?:\/\/\S+/gi,
    replacement: "[redacted-url]",
  },
  {
    pattern: /\+?\d[\d()\-\s]{7,}\d/g,
    replacement: "[redacted-phone]",
  },
  {
    pattern:
      /\b(?:api[_-]?key|token|secret|passwd|password)[=:]?[A-Za-z0-9._-]{8,}\b/gi,
    replacement: "[redacted-secret]",
  },
  {
    pattern:
      /\b(?:acct|account|user|org|workspace|team|project)[_-]?[A-Za-z0-9]{3,}\b/gi,
    replacement: "[redacted-account-id]",
  },
];

/**
 * Apply the canonical redaction patterns and collapse whitespace.
 *
 * `maxLength` truncates the result to a per-call-site safe budget. Callers
 * should pick a budget that matches the schema constraint they emit into
 * (e.g. 320 for `summary`, 240 for relevance `reason`).
 */
export function sanitizeText(value: string, maxLength: number): string {
  let result = value;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** Same as `sanitizeText` but preserves `undefined` for missing fields. */
export function sanitizeOptional(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const cleaned = sanitizeText(value, maxLength);
  return cleaned.length > 0 ? cleaned : undefined;
}
