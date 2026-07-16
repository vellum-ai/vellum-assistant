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
 * Version stamped as a `_redactionVersion` rider on daemon-persisted text
 * blocks whose raw text passed through {@link neutralizeRedactedSentinels}
 * before persistence. The daemon's history read boundary
 * (`renderHistoryContent`) neutralizes text blocks WITHOUT this rider —
 * rows persisted before the forgery guard existed — so a forged sentinel in
 * old history can never reach a chip-enabled client surface. Internal to the
 * daemon: the wire projection rebuilds blocks and never ships the rider.
 */
export const SENTINEL_REDACTION_VERSION = 2;

/**
 * Service/field segments are percent-encoded into the sentinel so arbitrary
 * credential identifiers survive the colon-delimited format. The credential
 * routes accept service/field as arbitrary strings — colon-qualified names
 * exist in real vaults (migration `018-rekey-compound-credential-keys`
 * produces `service = "integration:google"`), so a delimiter-collision
 * charset restriction would silently downgrade proven reveals for those
 * credentials to the non-revealable shape. Encoding keeps the common
 * kebab/snake identifiers fully legible while making every other string
 * representable.
 *
 * The encoded form contains only `[A-Za-z0-9_.%-]` — `encodeURIComponent`
 * plus the characters it leaves bare that fall outside that set — so the
 * sentinel regex stays unambiguous around its `:` delimiters and `〕` close.
 */
function encodeSentinelSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*~]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Inverse of {@link encodeSentinelSegment}. Returns undefined for malformed
 * percent-escapes — daemon-encoded segments always decode, and forged
 * sentinels are neutralized at persist time, so this path is defensive.
 */
function decodeSentinelSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

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
 * Build a sentinel string. Service/field are percent-encoded (see
 * {@link encodeSentinelSegment}), so any non-empty identifier the credential
 * routes accept — including colon-qualified names like `integration:google`
 * — round-trips through the enriched shape. Empty segments fall back to the
 * plain (non-revealable) shape; the function throws only if the type label
 * itself is unusable (which would mean a broken pattern table).
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
    service !== "" &&
    field !== ""
  ) {
    const encService = encodeSentinelSegment(service);
    const encField = encodeSentinelSegment(field);
    return `${base}:${encService}:${encField}${REDACTED_SENTINEL_CLOSE}`;
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
  // TYPE = anything except colon/brackets; SERVICE/FIELD = the
  // percent-encoded segment charset (see encodeSentinelSegment). Capture
  // groups carry the ENCODED segments — decode via decodeRedactedSentinelMatch.
  return new RegExp(
    `${REDACTED_SENTINEL_OPEN}${REDACTED_SENTINEL_TAG}:([^:\u3014\u3015]+?)(?::([A-Za-z0-9_.%-]+):([A-Za-z0-9_.%-]+))?${REDACTED_SENTINEL_CLOSE}`,
    "g",
  );
}

/**
 * Global-flag regex for locating NEUTRALIZED sentinels — the word-joiner
 * form {@link neutralizeRedactedSentinels} produces — inside a larger text.
 * Renderers use this to show a defused redaction marker as an inert badge
 * instead of leaking bare sentinel glyphs into the transcript. The capture
 * groups mirror {@link createRedactedSentinelRegex}, but consumers must NOT
 * trust them as vault coordinates: a neutralized span is by definition text
 * the daemon refused to vouch for. Same statefulness caveat as the genuine
 * regex — create a fresh instance per iteration.
 */
export function createNeutralizedSentinelRegex(): RegExp {
  return new RegExp(
    `${REDACTED_SENTINEL_OPEN}\\u2060${REDACTED_SENTINEL_TAG}:([^:\\u3014\\u3015]+?)(?::([A-Za-z0-9_.%-]+):([A-Za-z0-9_.%-]+))?${REDACTED_SENTINEL_CLOSE}`,
    "g",
  );
}

/**
 * Map a {@link createRedactedSentinelRegex} match to a decoded sentinel.
 * Shared by {@link parseRedactedSentinel} and the web rehype plugin so the
 * segment decoding never drifts between consumers. A malformed
 * percent-escape (unreachable for daemon-minted sentinels; forged ones are
 * neutralized at persist) degrades to the plain non-revealable shape rather
 * than surfacing bogus vault coordinates.
 */
export function decodeRedactedSentinelMatch(
  m: RegExpExecArray,
): RedactedCredentialSentinel {
  const [, type, encService, encField] = m;
  if (encService !== undefined && encField !== undefined) {
    const service = decodeSentinelSegment(encService);
    const field = decodeSentinelSegment(encField);
    if (service !== undefined && field !== undefined) {
      return { type, service, field };
    }
  }
  return { type };
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
  return decodeRedactedSentinelMatch(m);
}
