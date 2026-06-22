/**
 * Admission policy enforcement stage.
 *
 * Sits between `resolveTrustContext()` and the agent-loop dispatch in
 * `inbound-message-handler.ts`. The gateway attaches a per-channel-type
 * floor (`sourceMetadata.admissionPolicy`); this stage compares the floor
 * to the resolved trust class's rank and either admits or denies.
 *
 * Deny semantics — see `wave-b-plan.md` §8.2:
 *
 * - `shouldChallenge: true` when the policy is one that re-verification
 *   could lift past (`any_contact`, `strangers`). The caller fires the
 *   existing Slack DM / email upgrade UX so the sender knows verification
 *   would admit them.
 * - `shouldChallenge: false` for the stricter floors (`guardian_only`,
 *   `trusted_contacts`). Denials are silent — sender gets the standard
 *   canned reply; guardian still gets the access-request notification.
 *
 * Blocked / revoked members short-circuit to deny regardless of policy.
 * The gateway kill switch (`no_one`) is enforced before forwarding, so
 * this stage never sees a `no_one` policy on the wire; we still handle
 * the value defensively for defense in depth and unit-test reachability.
 */

import {
  ADMISSION_FLOOR,
  type AdmissionPolicy,
  isAdmissionPolicyExemptChannel,
} from "@vellumai/gateway-client";

import type { ChannelId } from "../../../channels/types.js";
import type { ChannelStatus } from "../../../contacts/types.js";
import type { TrustClass } from "../../actor-trust-resolver.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdmissionPolicyInput {
  sourceChannel: ChannelId;
  trustClass: TrustClass;
  /**
   * Channel record status for the resolved member, when one was found.
   * Blocked/revoked short-circuit to deny regardless of floor.
   */
  memberStatus: ChannelStatus | undefined;
  /** Per-channel-type floor attached by the gateway. */
  policy: AdmissionPolicy;
}

export type AdmissionDenyReason =
  | "member_blocked"
  | "member_revoked"
  | `admission_policy_${AdmissionPolicy}`;

export type AdmissionPolicyResult =
  | { admitted: true }
  | {
      admitted: false;
      reason: AdmissionDenyReason;
      /**
       * Whether the runtime should fire the re-verification upgrade UX
       * (Slack DM / email guardian forwarder). Only meaningful when the
       * resolved trust class could clear the floor after verification.
       */
      shouldChallenge: boolean;
      /** Effective policy that produced the deny (after override resolution). */
      effectivePolicy: AdmissionPolicy;
    };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Trust-class ordinal compared against {@link ADMISSION_FLOOR} to make the
 * admission decision (`rank >= floor`). Higher rank = more trusted.
 * Blocked/revoked never reach this comparison — they short-circuit to deny on
 * member status above — so they carry no rank here.
 *
 * The two halves of the floor check: this table is keyed by `TrustClass`,
 * `ADMISSION_FLOOR` (from `@vellumai/gateway-client`) by `AdmissionPolicy`.
 * They are only ever read together, here, so they live next to their use.
 */
const TRUST_CLASS_RANK: Record<TrustClass, number> = {
  guardian: 4,
  trusted_contact: 3,
  unverified_contact: 2,
  unknown: 1,
};

/**
 * Policies under which completing verification could lift the sender past
 * the floor. Used to decide whether to fire the upgrade UX on deny.
 * `unverified_contact` (rank 2) reaches `any_contact` (floor 2) and
 * `strangers` (floor 1); below those, verification still leaves the
 * sender short of the floor (§8.2).
 */
const POLICIES_THAT_COULD_UPGRADE: ReadonlySet<AdmissionPolicy> = new Set([
  "any_contact",
  "strangers",
]);

/**
 * Enforce the admission policy floor against the resolved trust class.
 *
 * Pure function — all I/O happens in the caller. Returns the canned
 * admit/deny verdict; the caller wires denials into the existing
 * canned-reply / guardian-notify pipeline used by `acl-enforcement.ts` for
 * `not_a_member`.
 */
export function enforceAdmissionPolicy(
  input: AdmissionPolicyInput,
): AdmissionPolicyResult {
  // §8.1: short-circuit on internal exempt channels. The gateway should
  // not have attached a policy for these in the first place; this is
  // defense in depth and keeps the runtime fail-open if the gateway is
  // ever called from a path that bypasses the kill-switch insertion.
  if (isAdmissionPolicyExemptChannel(input.sourceChannel)) {
    return { admitted: true };
  }

  // Blocked and revoked members never clear admission regardless of floor.
  // `enforceIngressAcl` already short-circuits on both: blocked always, and
  // revoked under any policy including `strangers` (§8 fix: revoked is an
  // explicit governance action, not the same as an unknown stranger). The
  // checks here are defense-in-depth so unit tests can drive the floor stage
  // in isolation and a future refactor that reorders stages doesn't silently
  // admit a blocked/revoked actor.
  if (input.memberStatus === "blocked" || input.memberStatus === "revoked") {
    return {
      admitted: false,
      reason:
        input.memberStatus === "blocked" ? "member_blocked" : "member_revoked",
      shouldChallenge: false,
      effectivePolicy: input.policy,
    };
  }

  const effectivePolicy = input.policy;

  const rank = TRUST_CLASS_RANK[input.trustClass];
  const floor = ADMISSION_FLOOR[effectivePolicy];

  if (rank >= floor) {
    return { admitted: true };
  }

  return {
    admitted: false,
    reason: `admission_policy_${effectivePolicy}` as const,
    shouldChallenge: POLICIES_THAT_COULD_UPGRADE.has(effectivePolicy),
    effectivePolicy,
  };
}
