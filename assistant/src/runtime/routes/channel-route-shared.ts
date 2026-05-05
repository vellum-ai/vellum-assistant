/**
 * Shared types, constants, and utilities used across channel route modules.
 */
import type { ChannelId } from "../../channels/types.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import type {
  ApprovalAction,
  ApprovalDecisionResult,
  ApprovalUIMetadata,
} from "../channel-approval-types.js";

/** Canonicalize assistantId for channel ingress paths. */
export function canonicalChannelAssistantId(_assistantId: string): string {
  return DAEMON_INTERNAL_ASSISTANT_ID;
}

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

const VALID_ACTIONS: ReadonlySet<string> = new Set<string>([
  "approve_once",
  "reject",
]);

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
  if (parts.length < 3 || parts[0] !== "apr") return null;
  const requestId = parts[1];
  const rawAction = parts.slice(2).join(":");
  const action = LEGACY_CALLBACK_MAP[rawAction] ?? rawAction;
  if (!requestId || !VALID_ACTIONS.has(action)) return null;
  const source =
    sourceChannel === "whatsapp"
      ? ("whatsapp_button" as const)
      : sourceChannel === "slack"
        ? ("slack_button" as const)
        : ("telegram_button" as const);
  return { action: action as ApprovalAction, source, requestId };
}

// ---------------------------------------------------------------------------
// Reaction callback data parser — format: "reaction:<emoji_name>"
// ---------------------------------------------------------------------------

/**
 * Map of Slack emoji names to approval actions. Multiple emoji names can
 * map to the same action to handle Slack's aliasing (e.g. `+1` and `thumbsup`
 * both represent the thumbs-up emoji).
 */
const REACTION_EMOJI_MAP: ReadonlyMap<string, ApprovalAction> = new Map([
  ["+1", "approve_once"],
  ["thumbsup", "approve_once"],
  ["white_check_mark", "approve_once"],
  ["alarm_clock", "approve_once"],
  ["-1", "reject"],
  ["thumbsdown", "reject"],
]);

/**
 * Parse a `reaction:<emoji_name>` callback data string into an approval
 * decision. Returns null if the emoji is not mapped to any action.
 */
export function parseReactionCallbackData(
  data: string,
): ApprovalDecisionResult | null {
  if (!data.startsWith("reaction:")) return null;
  const emoji = data.slice("reaction:".length);
  const action = REACTION_EMOJI_MAP.get(emoji);
  if (!action) return null;
  return { action, source: "slack_reaction" };
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
