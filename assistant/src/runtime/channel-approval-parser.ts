/**
 * Channel-agnostic plain-text approval decision parser.
 *
 * Parses inbound user text to determine whether it matches an approval,
 * rejection, or "approve always" intent. This module is transport-agnostic
 * and can be used by any channel adapter (Telegram, SMS, etc.).
 */

import type { ApprovalAction, ApprovalDecisionResult } from './channel-approval-types.js';

// ---------------------------------------------------------------------------
// Phrase → action mapping
// ---------------------------------------------------------------------------

const APPROVE_ONCE_PHRASES = ['yes', 'approve', 'approve once', 'allow', 'go ahead'];
const APPROVE_ALWAYS_PHRASES = ['always', 'approve always', 'allow always'];
const REJECT_PHRASES = ['no', 'reject', 'deny', 'cancel'];

/**
 * Build a Map from lowercased phrase to action. "Approve always" phrases
 * are checked first (longest-match-wins) because "approve" is a prefix
 * of "approve always".
 */
function buildPhraseMap(): Map<string, ApprovalAction> {
  const map = new Map<string, ApprovalAction>();

  // Insert longer phrases first so iteration order does not matter —
  // we match on exact equality after normalising, not prefix matching.
  for (const phrase of APPROVE_ALWAYS_PHRASES) {
    map.set(phrase, 'approve_always');
  }
  for (const phrase of APPROVE_ONCE_PHRASES) {
    map.set(phrase, 'approve_once');
  }
  for (const phrase of REJECT_PHRASES) {
    map.set(phrase, 'reject');
  }
  return map;
}

const PHRASE_MAP = buildPhraseMap();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a plain-text message into an approval decision.
 *
 * Returns a structured `ApprovalDecisionResult` if the text matches one
 * of the known intent phrases, or `null` if it does not match.
 *
 * Matching is case-insensitive with leading/trailing whitespace trimmed.
 */
export function parseApprovalDecision(text: string): ApprovalDecisionResult | null {
  const normalised = text.trim().toLowerCase();
  const action = PHRASE_MAP.get(normalised);
  if (!action) return null;
  return { action, source: 'plain_text' };
}
