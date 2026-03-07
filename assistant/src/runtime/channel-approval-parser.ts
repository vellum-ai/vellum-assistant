/**
 * Channel-agnostic plain-text approval decision parser.
 *
 * Parses inbound user text to determine whether it matches an approval,
 * rejection, or "approve always" intent. This module is transport-agnostic
 * and can be used by any channel adapter (Telegram, Slack, etc.).
 *
 * Both the standard and guardian approval flows now use the conversational
 * approval engine as the primary classifier. This deterministic parser is
 * retained only as a legacy fallback for when the conversational engine is
 * not injected (i.e. approvalConversationGenerator is undefined).
 */

import type {
  ApprovalAction,
  ApprovalDecisionResult,
} from "./channel-approval-types.js";

// ---------------------------------------------------------------------------
// Phrase → action mapping
// ---------------------------------------------------------------------------

const APPROVE_ONCE_PHRASES = [
  "yes",
  "approve",
  "approve once",
  "allow",
  "go ahead",
];
const APPROVE_10M_PHRASES = [
  "approve for 10 minutes",
  "allow for 10 minutes",
  "approve 10m",
  "allow 10m",
  "approve 10 min",
  "allow 10 min",
];
const APPROVE_THREAD_PHRASES = [
  "approve for thread",
  "allow for thread",
  "approve thread",
  "allow thread",
];
const APPROVE_ALWAYS_PHRASES = ["always", "approve always", "allow always"];
const REJECT_PHRASES = ["no", "reject", "deny", "cancel"];

/**
 * Build a Map from lowercased phrase to action. Longer phrases are
 * inserted first so iteration order does not matter — we match on
 * exact equality after normalising, not prefix matching.
 */
function buildPhraseMap(): Map<string, ApprovalAction> {
  const map = new Map<string, ApprovalAction>();

  for (const phrase of APPROVE_ALWAYS_PHRASES) {
    map.set(phrase, "approve_always");
  }
  for (const phrase of APPROVE_10M_PHRASES) {
    map.set(phrase, "approve_10m");
  }
  for (const phrase of APPROVE_THREAD_PHRASES) {
    map.set(phrase, "approve_thread");
  }
  for (const phrase of APPROVE_ONCE_PHRASES) {
    map.set(phrase, "approve_once");
  }
  for (const phrase of REJECT_PHRASES) {
    map.set(phrase, "reject");
  }
  return map;
}

const PHRASE_MAP = buildPhraseMap();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Run-reference tag extraction
// ---------------------------------------------------------------------------

/**
 * Pattern matching a `[ref:<requestId>]` disambiguation tag appended to
 * plain-text approval prompts. Guardians can include this tag in their
 * reply so that `handleApprovalInterception` can resolve the correct
 * pending approval when multiple approvals target the same chat.
 */
const REF_TAG_RE = /\[ref:([^\]]+)\]/i;

/**
 * Extract a request-reference tag from the text and return the cleaned
 * decision text plus the extracted requestId (if any).
 */
function extractRefTag(text: string): { cleaned: string; requestId?: string } {
  const match = REF_TAG_RE.exec(text);
  if (!match) return { cleaned: text };
  const requestId = match[1].trim();
  const cleaned = text.replace(REF_TAG_RE, "").trim();
  return { cleaned, requestId: requestId || undefined };
}

/**
 * Parse a plain-text message into an approval decision.
 *
 * Returns a structured `ApprovalDecisionResult` if the text matches one
 * of the known intent phrases, or `null` if it does not match.
 *
 * Matching is case-insensitive with leading/trailing whitespace trimmed.
 *
 * When the text contains a `[ref:<requestId>]` tag (appended by the
 * plain-text fallback path), the extracted requestId is included in the
 * result so the caller can disambiguate among multiple pending approvals.
 */
export function parseApprovalDecision(
  text: string,
): ApprovalDecisionResult | null {
  const { cleaned, requestId } = extractRefTag(text);
  const normalised = cleaned.trim().toLowerCase();
  const action = PHRASE_MAP.get(normalised);
  if (!action) return null;
  return { action, source: "plain_text", ...(requestId ? { requestId } : {}) };
}
