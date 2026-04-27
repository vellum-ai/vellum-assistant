/**
 * Natural language approval intent parser.
 *
 * Parses short inbound messages (e.g. from Slack) to determine whether the
 * entire message expresses an approval or rejection intent.
 * Only matches when the full message is an approval/rejection phrase -- does
 * NOT match partial intent inside longer sentences like "yes but also do X".
 *
 * This parser covers a broad set of colloquial patterns and emoji
 * for approval intent detection.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ApprovalDecision = "approve" | "reject";

export interface ApprovalIntent {
  decision: ApprovalDecision;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

/** Exact-match phrases (after normalization) for approval. */
const APPROVE_EXACT: ReadonlySet<string> = new Set([
  "yes",
  "yep",
  "yeah",
  "yea",
  "yup",
  "approved",
  "approve",
  "go ahead",
  "do it",
  "sure",
  "ok",
  "okay",
  "k",
  "lgtm",
  "sounds good",
  "go for it",
  "please",
  "pls",
  "y",
  "\u{1F44D}", // 👍
]);

/** Exact-match phrases for rejection. */
const REJECT_EXACT: ReadonlySet<string> = new Set([
  "no",
  "nope",
  "nah",
  "reject",
  "rejected",
  "denied",
  "deny",
  "don't",
  "dont",
  "cancel",
  "stop",
  "n",
  "\u{1F44E}", // 👎
]);


// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize input: lowercase, trim, strip `[ref:...]` disambiguation tags,
 * strip trailing punctuation (except emoji), collapse internal whitespace.
 */
function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\[ref:[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?,;:]+$/, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a message for approval/rejection intent.
 *
 * Returns an `ApprovalIntent` when the entire message clearly expresses a
 * single approval or rejection decision. Returns `null` when no intent is
 * detected or when the message contains additional content beyond the
 * decision phrase.
 */
export function parseApprovalIntent(text: string): ApprovalIntent | null {
  const normalized = normalize(text);

  if (normalized.length === 0) return null;

  // Reject messages that are too long to be a simple decision phrase.
  // This prevents matching approval words buried inside longer messages.
  if (normalized.length > 40) return null;

  // Exact approval match.
  if (APPROVE_EXACT.has(normalized)) {
    return { decision: "approve", confidence: 0.95 };
  }

  // Exact rejection match.
  if (REJECT_EXACT.has(normalized)) {
    return { decision: "reject", confidence: 0.95 };
  }

  // Legacy timed/persistent phrases — treat as simple approval.
  // These used to produce approve_10m / approve_always but now collapse to approve.
  const LEGACY_TIMED_PATTERN =
    /^(?:yes|ok|okay|sure|yep|yeah|go\s+ahead|approve|allow)\s+(?:(?:for\s+)?\d+\s*(?:m|min|minutes?)|for\s+now)$/i;
  if (
    /^always\s+allow$/i.test(normalized) ||
    /^approve\s+always$/i.test(normalized) ||
    LEGACY_TIMED_PATTERN.test(normalized)
  ) {
    return { decision: "approve", confidence: 0.95 };
  }

  return null;
}
