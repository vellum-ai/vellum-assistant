/**
 * Canonical vocabulary for guardian requests, shared by the gateway that owns
 * the request rows, the daemon that decides and projects them, and the web
 * that renders the projection: a request's lifecycle status, the actions a
 * guardian can decide it with, and the weight a card gives each action.
 */
import { z } from "zod";

export const GUARDIAN_REQUEST_STATUS_VALUES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
] as const;
export const GuardianRequestStatusSchema = z.enum(
  GUARDIAN_REQUEST_STATUS_VALUES,
);
export type GuardianRequestStatus = z.infer<typeof GuardianRequestStatusSchema>;

/**
 * The actions a guardian can decide a request with.
 *
 * `approve_once` / `reject` are the generic decision pair used by every
 * request kind. `trust` / `verify_code` / `leave_unverified` / `block` are the
 * introduction-card actions, valid only for `access_request` requests.
 */
export const GUARDIAN_DECISION_ACTION_IDS = [
  "approve_once",
  "reject",
  "trust",
  "verify_code",
  "leave_unverified",
  "block",
] as const;
export const GuardianDecisionActionIdSchema = z.enum(
  GUARDIAN_DECISION_ACTION_IDS,
);
export type GuardianDecisionActionId = z.infer<
  typeof GuardianDecisionActionIdSchema
>;

/** Actions that resolve a request to `denied`; every other one approves. */
export const GUARDIAN_DENYING_ACTION_VALUES = [
  "reject",
  "leave_unverified",
  "block",
] as const satisfies readonly GuardianDecisionActionId[];

/**
 * The denying actions that park the sender at `unverified`: a neutral hold,
 * not a rejection. A parked contact is still admitted under the permissive
 * admission floors (`any_contact`, `strangers`) and can be trusted or verified
 * later; contrast `block` (revoked, a hard keep-out) and `reject` (an explicit
 * decline). All three resolve the request to `denied`, so a resolved card
 * consults this to read a park neutrally rather than as a denial.
 */
export const GUARDIAN_PARK_ACTION_VALUES = [
  "leave_unverified",
] as const satisfies readonly GuardianDecisionActionId[];

const DENYING_ACTIONS: ReadonlySet<string> = new Set(
  GUARDIAN_DENYING_ACTION_VALUES,
);
const PARK_ACTIONS: ReadonlySet<string> = new Set(GUARDIAN_PARK_ACTION_VALUES);

/** True when `action` resolves a request to `denied`. */
export function isDenyingGuardianAction(action: string | undefined): boolean {
  return action !== undefined && DENYING_ACTIONS.has(action);
}

/** True when `action` parks the sender at `unverified`. */
export function isParkGuardianAction(action: string | undefined): boolean {
  return action !== undefined && PARK_ACTIONS.has(action);
}

/**
 * Surface-agnostic weight of a card action. Each renderer translates it to
 * its own token (Slack primary/danger, a web button variant); absent means the
 * renderer's default.
 */
export const GUARDIAN_ACTION_EMPHASIS_VALUES = [
  "primary",
  "secondary",
  "destructive",
] as const;
export const GuardianActionEmphasisSchema = z.enum(
  GUARDIAN_ACTION_EMPHASIS_VALUES,
);
export type GuardianActionEmphasis = z.infer<
  typeof GuardianActionEmphasisSchema
>;
