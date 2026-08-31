/**
 * Shared types, constants, and utilities used across channel route modules.
 */
import type { ChannelId } from "../../channels/types.js";
import {
  type ApprovalAction,
  type ApprovalDecisionResult,
  type ApprovalUIMetadata,
  isApprovalAction,
} from "../channel-approval-types.js";

// ---------------------------------------------------------------------------
// Actor role
// ---------------------------------------------------------------------------

/** Guardian approval request expiry (30 minutes). */
export const GUARDIAN_APPROVAL_TTL_MS = 30 * 60 * 1000;

/**
 * Keywords the plain-text parser accepts for approval decisions. We require
 * these in generated plain-text prompts so text fallback remains actionable.
 */
export function requiredDecisionKeywords(
  _actions: ApprovalUIMetadata["actions"],
): string[] {
  return ["yes", "no"];
}

// ---------------------------------------------------------------------------
// Callback data parser — format: "apr:<requestId>:<action>"
// ---------------------------------------------------------------------------

/** Map legacy callback actions to canonical ones for in-flight buttons. */
const LEGACY_CALLBACK_MAP: Record<string, string> = {
  approve_10m: "approve_once",
  approve_conversation: "approve_once",
  approve_always: "approve_once",
};

export function parseCallbackData(
  data: string,
  sourceChannel?: string,
): ApprovalDecisionResult | null {
  const parts = data.split(":");
  if (parts.length < 3 || parts[0] !== "apr") {
    return null;
  }
  const requestId = parts[1];
  const rawAction = parts.slice(2).join(":");
  const action = LEGACY_CALLBACK_MAP[rawAction] ?? rawAction;
  if (!requestId || !isApprovalAction(action)) {
    return null;
  }
  const source =
    sourceChannel === "vellum"
      ? ("vellum_surface" as const)
      : ("button" as const);
  return { action, source, requestId };
}

// ---------------------------------------------------------------------------
// Reaction decision vocabulary
// ---------------------------------------------------------------------------

/**
 * Map of reaction emoji to approval actions, in each channel's own
 * vocabulary: Slack reactions carry colon names (with aliasing, e.g. `+1`
 * and `thumbsup` are both the thumbs-up emoji), Telegram and Discord carry
 * the unicode character itself. Telegram's fixed reaction set offers the
 * thumbs but not the check mark or alarm clock; Discord offers all four.
 */
const REACTION_EMOJI_MAP: ReadonlyMap<string, ApprovalAction> = new Map([
  ["+1", "approve_once"],
  ["thumbsup", "approve_once"],
  ["white_check_mark", "approve_once"],
  ["alarm_clock", "approve_once"],
  ["-1", "reject"],
  ["thumbsdown", "reject"],
  ["\u{1F44D}", "approve_once"], // thumbs up
  ["\u2705", "approve_once"], // check mark button
  ["\u23F0", "approve_once"], // alarm clock
  ["\u{1F44E}", "reject"], // thumbs down
]);

/**
 * Map a reaction emoji, in the source channel's own vocabulary, to an
 * approval decision. Returns null if the emoji is not mapped to any action.
 */
export function reactionDecisionForEmoji(
  emoji: string,
): ApprovalDecisionResult | null {
  const action = REACTION_EMOJI_MAP.get(emoji);
  if (!action) {
    return null;
  }
  return { action, source: "reaction" };
}

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

/**
 * Build contextual deny guidance for guardian-gated auto-deny paths.
 * This is passed through the confirmation pipeline so the assistant can
 * produce a single, user-facing message with next steps.
 */
export function buildGuardianDenyContext(
  toolName: string,
  denialReason: "no_binding" | "no_identity",
  _sourceChannel: ChannelId,
): string {
  if (denialReason === "no_identity") {
    return `Permission denied for "${toolName}": guardian approval was required, but requester identity could not be verified for this channel. In your next assistant reply, explain this clearly, avoid retrying yet, and ask the user to message from a verifiable direct account/chat before retrying.`;
  }

  return `Permission denied for "${toolName}": guardian approval was required, but no guardian is configured for this channel. In your next assistant reply, explain this and offer guardian setup. Mention that setup provides a verification code that the user replies with in the channel.`;
}

export function stripVerificationFailurePrefix(reason: string): string {
  const trimmed = reason.trim();
  return trimmed.replace(/^verification failed\.?\s*/i, "").trim() || trimmed;
}
let _testPollMaxWaitOverride: number | null = null;

/** @internal — test-only: set an override for the poll max-wait. */
export function _setTestPollMaxWait(ms: number | null): void {
  _testPollMaxWaitOverride = ms;
}
