/**
 * Channel-agnostic approval flow types.
 *
 * Wire-format types (`ApprovalUIMetadata`, `PermissionRequestDetails`,
 * `ApprovalActionOption`) are defined as Zod schemas in
 * `@vellumai/gateway-client/outbound-contract` and re-exported here for
 * convenience. Daemon-internal types that do not cross a wire boundary
 * are defined locally.
 */

import type { ApprovalActionOption } from "@vellumai/gateway-client";

import type { GuardianDecisionAction } from "./guardian-decision-types.js";

// Re-export shared wire types so existing daemon imports keep working.
export type {
  ApprovalActionOption,
  ApprovalUIMetadata,
  PermissionRequestDetails,
} from "@vellumai/gateway-client";

// ---------------------------------------------------------------------------
// Approval actions (daemon-internal)
// ---------------------------------------------------------------------------

/** The set of actions a user can take on an approval prompt. */
export type ApprovalAction = "approve_once" | "reject";

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
    id: a.action,
    label: a.label,
  }));
}

// ---------------------------------------------------------------------------
// Approval prompt (daemon-internal)
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
// Decision result (daemon-internal)
// ---------------------------------------------------------------------------

/** How the user communicated their decision. */
export type ApprovalDecisionSource =
  | "telegram_button"
  | "whatsapp_button"
  | "slack_button"
  | "slack_reaction"
  | "vellum_surface"
  | "plain_text";

/** The structured result of a user's approval decision. */
export interface ApprovalDecisionResult {
  action: ApprovalAction;
  source: ApprovalDecisionSource;
  /** Request ID extracted from callback data (button presses only). */
  requestId?: string;
}
