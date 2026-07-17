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

export type {
  ApprovalActionOption,
  ApprovalUIMetadata,
  PermissionRequestDetails,
} from "@vellumai/gateway-client";
// Re-export shared wire types + schemas so existing daemon imports keep working.
export {
  ApprovalUIMetadataSchema,
  PermissionRequestDetailsSchema,
} from "@vellumai/gateway-client";

// ---------------------------------------------------------------------------
// Approval actions (daemon-internal)
// ---------------------------------------------------------------------------

/**
 * The set of actions a user can take on an approval prompt.
 *
 * `approve_once` / `reject` are the generic decision pair used by every
 * request kind. `trust` / `verify_code` / `leave_unverified` / `block` are the
 * introduction-card actions, valid only for `access_request` requests — the
 * guardian decision primitive rejects them for any other kind.
 */
export const APPROVAL_ACTION_IDS = [
  "approve_once",
  "reject",
  "trust",
  "verify_code",
  "leave_unverified",
  "block",
] as const;

export type ApprovalAction = (typeof APPROVAL_ACTION_IDS)[number];

/** All valid approval action ids, for wire-input validation. */
export const APPROVAL_ACTION_SET: ReadonlySet<string> = new Set(
  APPROVAL_ACTION_IDS,
);

/**
 * Type predicate tying the runtime membership check to the `ApprovalAction`
 * type, so wire-input validation sites never need an `as` cast.
 */
export function isApprovalAction(value: string): value is ApprovalAction {
  return APPROVAL_ACTION_SET.has(value);
}

/**
 * Introduction-card actions. Only meaningful for `access_request` requests:
 * the guardian sets the contact's trust level directly on the card.
 */
export const INTRODUCTION_ACTION_SET: ReadonlySet<string> = new Set([
  "trust",
  "verify_code",
  "leave_unverified",
  "block",
]);

/**
 * Actions that resolve a request to the `denied` terminal status. Everything
 * else resolves to `approved`.
 */
export const DENYING_ACTION_SET: ReadonlySet<string> = new Set([
  "reject",
  "leave_unverified",
  "block",
]);

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
