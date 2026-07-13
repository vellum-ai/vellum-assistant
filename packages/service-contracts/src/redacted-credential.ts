/**
 * Redacted-credential sentinel — the shared wire format for chat-persisted
 * secret redactions.
 *
 * When the daemon persists a chat message containing a detected secret (and
 * the `chat-credential-reveal` feature flag is on), the secret is replaced
 * with a plain-text sentinel instead of the legacy `<redacted type="…" />`
 * HTML marker. The sentinel is plain text on purpose: the chat markdown
 * pipeline has no rehype-raw, so an HTML marker can never become an element —
 * a text sentinel survives markdown parsing as an ordinary text node that a
 * rehype plugin can match and upgrade into an interactive chip.
 *
 * Two shapes:
 *   `〔redacted:TYPE〕`                — secret detected, vault identity unknown
 *   `〔redacted:TYPE:SERVICE:FIELD〕`  — secret byte-matched to a stored credential
 *
 * The enriched shape is only emitted when the daemon has *proven* the match
 * (exact plaintext comparison against a credential fetched for this turn) —
 * never inferred. A wrong SERVICE:FIELD here would let the client reveal the
 * wrong secret, so producers must treat enrichment as opt-in per proven match.
 *
 * The corner brackets (U+3014/U+3015) were chosen because they are not
 * markdown syntax characters, never appear in the secret formats we detect,
 * and are visually distinct if a client without chip support renders the raw
 * sentinel.
 *
 * This module is shared by the daemon (producer) and clients/web (consumer)
 * so the format can never drift between the two. It is intentionally
 * dependency-free and data-only.
 */

export const REDACTED_SENTINEL_OPEN = "\u3014"; // 〔
export const REDACTED_SENTINEL_CLOSE = "\u3015"; // 〕
export const REDACTED_SENTINEL_TAG = "redacted";

/**
 * Charset for service/field segments. Matches the daemon's credential
 * service/field naming (kebab/snake identifiers). Anything outside this set
 * is refused at build time — the producer falls back to the plain shape
 * rather than emit a sentinel the parser would misread.
 */
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Charset for the TYPE label. Pattern labels are our own
 * (`secret-patterns.ts` / scanner-only patterns) and contain only words,
 * spaces, and hyphens — but validate anyway so a future label containing a
 * colon or bracket cannot silently corrupt the format.
 */
const TYPE_RE = /^[^:\u3014\u3015]+$/;

export interface RedactedCredentialSentinel {
  /** Human-readable secret type label, e.g. "Anthropic API Key". */
  type: string;
  /** Vault service namespace — present only when the match was proven. */
  service?: string;
  /** Vault field name — present only when the match was proven. */
  field?: string;
}

/** True when the sentinel carries a proven vault identity. */
export function isRevealableSentinel(
  s: RedactedCredentialSentinel,
): s is RedactedCredentialSentinel & { service: string; field: string } {
  return s.service !== undefined && s.field !== undefined;
}

/**
 * Build a sentinel string. Falls back to the plain (non-revealable) shape if
 * the service/field fail charset validation, and throws only if the type
 * label itself is unusable (which would mean a broken pattern table).
 */
export function buildRedactedSentinel(
  sentinel: RedactedCredentialSentinel,
): string {
  const { type, service, field } = sentinel;
  if (!TYPE_RE.test(type)) {
    throw new Error(`Invalid redacted-sentinel type label: ${type}`);
  }
  const base = `${REDACTED_SENTINEL_OPEN}${REDACTED_SENTINEL_TAG}:${type}`;
  if (
    service !== undefined &&
    field !== undefined &&
    SEGMENT_RE.test(service) &&
    SEGMENT_RE.test(field)
  ) {
    return `${base}:${service}:${field}${REDACTED_SENTINEL_CLOSE}`;
  }
  return `${base}${REDACTED_SENTINEL_CLOSE}`;
}

/**
 * Global-flag regex for locating sentinels inside a larger text. Callers must
 * not share a single instance across concurrent iterations (stateful
 * `lastIndex`); use {@link createRedactedSentinelRegex}.
 */
export function createRedactedSentinelRegex(): RegExp {
  // 〔redacted:TYPE〕 or 〔redacted:TYPE:SERVICE:FIELD〕
  // TYPE = anything except colon/brackets; SERVICE/FIELD = identifier charset.
  return new RegExp(
    `${REDACTED_SENTINEL_OPEN}${REDACTED_SENTINEL_TAG}:([^:\u3014\u3015]+?)(?::([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+))?${REDACTED_SENTINEL_CLOSE}`,
    "g",
  );
}

/**
 * Neutralize sentinel-shaped strings that were NOT produced by the redactor.
 *
 * The sentinel is plain text, so any content source (model output quoting a
 * transcript, fetched web content, a pasted message) could otherwise forge
 * one and manufacture a reveal chip for an arbitrary stored credential.
 * Producers must call this on raw text *before* inserting their own
 * sentinels, so the only sentinels that survive persistence are the ones the
 * redactor itself emitted from a detected secret.
 *
 * Neutralization inserts a word joiner (U+2060, zero-width, non-breaking)
 * after the opening bracket — visually identical for a human reading a
 * quoted sentinel, but the consumer regex no longer matches. Idempotent:
 * after one pass the trigger prefix no longer occurs, so re-running is a
 * no-op and never corrupts text further.
 */
export function neutralizeRedactedSentinels(text: string): string {
  const trigger = `${REDACTED_SENTINEL_OPEN}${REDACTED_SENTINEL_TAG}:`;
  if (!text.includes(trigger)) return text;
  return text.replaceAll(
    trigger,
    `${REDACTED_SENTINEL_OPEN}\u2060${REDACTED_SENTINEL_TAG}:`,
  );
}

/**
 * Parse a single exact sentinel string (the whole input must be one
 * sentinel). Returns undefined when the input is not a valid sentinel.
 */
export function parseRedactedSentinel(
  text: string,
): RedactedCredentialSentinel | undefined {
  const re = createRedactedSentinelRegex();
  const m = re.exec(text);
  if (!m || m[0] !== text) return undefined;
  const [, type, service, field] = m;
  return service !== undefined && field !== undefined
    ? { type, service, field }
    : { type };
}
