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
import {
  GUARDIAN_DECISION_ACTION_IDS,
  isParkGuardianAction,
} from "@vellumai/service-contracts/guardian-requests";

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
export const APPROVAL_ACTION_IDS = GUARDIAN_DECISION_ACTION_IDS;

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

/** Completed-card label shown for a parked (leave-unverified) decision. */
export const PARK_STATUS_LABEL = "Left unverified";

/** Outcome word per terminal guardian-request status on a resolved card. */
const DECISION_STATUS_WORDS: Record<string, string> = {
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  cancelled: "Cancelled",
};

/**
 * The outcome word shown on a resolved guardian-request card, shared by every
 * surface (in-app, Slack, Telegram); surfaces add only their own glyph
 * vocabulary around it. A `denied` status reached by a park action reads as
 * the neutral {@link PARK_STATUS_LABEL} rather than "Denied": a parked
 * contact was neither trusted nor kept out.
 */
export function resolveDecisionStatusWord(
  status: string,
  decidedAction?: string,
): string {
  if (status === "denied" && isParkGuardianAction(decidedAction)) {
    return PARK_STATUS_LABEL;
  }
  return DECISION_STATUS_WORDS[status] ?? "Resolved";
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

/**
 * How the user communicated their decision: the modality, never the channel.
 * A channel-prefixed value here would misattribute the next channel that
 * joins (every channel's buttons ride the same `apr:` callback), and no
 * consumer reads a channel off this field.
 */
export type ApprovalDecisionSource = "button" | "vellum_surface" | "plain_text";

/** The structured result of a user's approval decision. */
export interface ApprovalDecisionResult {
  action: ApprovalAction;
  source: ApprovalDecisionSource;
  /** Request ID extracted from callback data (button presses only). */
  requestId?: string;
}
