/**
 * Channel-agnostic approval flow types.
 *
 * These types model the approval prompt/decision lifecycle for tool-use
 * confirmations surfaced through external channels (Telegram, Slack, etc.).
 * They are intentionally decoupled from any specific channel so that the
 * same approval flow can be reused across transports.
 */

import type { GuardianDecisionAction } from "./guardian-decision-types.js";

// ---------------------------------------------------------------------------
// Approval actions
// ---------------------------------------------------------------------------

/** The set of actions a user can take on an approval prompt. */
export type ApprovalAction =
  | "approve_once"
  | "approve_10m"
  | "approve_thread"
  | "approve_always"
  | "reject";

/** An action presented to the user as a tappable button or text option. */
export interface ApprovalActionOption {
  id: ApprovalAction;
  label: string;
}

/**
 * Map `GuardianDecisionAction[]` to `ApprovalActionOption[]` so channel
 * prompt payloads can be derived from the unified decision action set.
 * The `action` field from GuardianDecisionAction maps to the `id` field
 * on ApprovalActionOption (both are canonical action identifiers).
 */
export function toApprovalActionOptions(
  actions: GuardianDecisionAction[],
): ApprovalActionOption[] {
  return actions.map((a) => ({
    id: a.action as ApprovalAction,
    label: a.label,
  }));
}

// ---------------------------------------------------------------------------
// Approval prompt
// ---------------------------------------------------------------------------

/** The approval prompt model sent to users via a channel. */
export interface ChannelApprovalPrompt {
  /** Human-readable description of what is being approved. */
  promptText: string;
  /** Available actions the user can take. */
  actions: ApprovalActionOption[];
  /** Instruction text for channels that only support plain text (no buttons). */
  plainTextFallback: string;
}

// ---------------------------------------------------------------------------
// Approval UI metadata (gateway callback payload)
// ---------------------------------------------------------------------------

/**
 * Tool-permission-specific details carried alongside the approval payload.
 * Channels that support rich UI (e.g. Slack Block Kit) use these fields
 * to render a detailed permission request card with risk indicators,
 * tool arguments, and requester identity.
 */
export interface PermissionRequestDetails {
  toolName: string;
  riskLevel: string;
  toolInput: Record<string, unknown>;
  /** Present for guardian-escalated requests to identify who is asking. */
  requesterIdentifier?: string;
}

/**
 * Metadata attached to gateway callback payloads so the channel adapter
 * can render approval UI and route the user's decision back to the
 * correct pending interaction.
 */
export interface ApprovalUIMetadata {
  requestId: string;
  actions: ApprovalActionOption[];
  plainTextFallback: string;
  /** When present, the approval is a tool permission request with extra context. */
  permissionDetails?: PermissionRequestDetails;
}

// ---------------------------------------------------------------------------
// Decision result
// ---------------------------------------------------------------------------

/** How the user communicated their decision. */
export type ApprovalDecisionSource =
  | "telegram_button"
  | "whatsapp_button"
  | "slack_button"
  | "slack_reaction"
  | "plain_text";

/** The structured result of a user's approval decision. */
export interface ApprovalDecisionResult {
  action: ApprovalAction;
  source: ApprovalDecisionSource;
  /** Request ID extracted from callback data (button presses only). */
  requestId?: string;
}
