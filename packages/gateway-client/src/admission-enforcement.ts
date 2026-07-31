/**
 * Shared admission-floor enforcement. The single implementation of the
 * "who gets in the door" decision (`TRUST_CLASS_RANK >= ADMISSION_FLOOR`).
 *
 * Consumed by BOTH sides of the split-enforcement design:
 *
 * - The runtime admission stage
 *   (`assistant/src/runtime/routes/inbound-stages/admission-policy.ts`)
 *   evaluates it for every forwarded inbound message, against the
 *   gateway-stamped verdict + floor.
 * - The channel conversation reset endpoint
 *   (`assistant/src/runtime/routes/inbound-conversation.ts`) evaluates it for
 *   gateway-terminal commands (`/new`), which never run the inbound message
 *   pipeline. That endpoint authorizes itself; the gateway only applies the
 *   `no_one` kill switch and forwards the verdict + floor.
 *
 * Living here keeps it one model: a channel command clears exactly the
 * admission decision a channel message would get, not a per-channel or
 * per-command re-implementation. Capabilities (what an admitted actor may
 * do) are NOT computed here. That axis stays in the runtime
 * (`assistant/src/runtime/capabilities.ts`), where the reset endpoint also
 * consults `resolveCapabilities` before mutating state.
 */

import {
  ADMISSION_FLOOR,
  type AdmissionPolicy,
  isAdmissionPolicyExemptChannel,
} from "./admission-policy-contract.js";
import type { TrustClass } from "./trust-verdict-contract.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdmissionPolicyInput {
  sourceChannel: string;
  trustClass: TrustClass;
  /**
   * Channel record status for the resolved member, when one was found.
   * Blocked/revoked short-circuit to deny regardless of floor. Kept loose
   * (`string`) to match the wire verdict's `status` field; the runtime
   * narrows it to its `ChannelStatus` union.
   */
  memberStatus: string | undefined;
  /** Per-channel-type floor resolved from the admission policy store. */
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
       * Whether the caller should fire the re-verification upgrade UX
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
 * Blocked/revoked never reach this comparison. They short-circuit to deny on
 * member status in {@link enforceAdmissionPolicy}, so they carry no rank
 * here.
 */
export const TRUST_CLASS_RANK: Record<TrustClass, number> = {
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
 * Pure function, all I/O happens in the caller. Returns the canned
 * admit/deny verdict; callers wire denials into their own reply/notify
 * pipelines.
 */
export function enforceAdmissionPolicy(
  input: AdmissionPolicyInput,
): AdmissionPolicyResult {
  // §8.1: short-circuit on internal exempt channels. Callers should not
  // have resolved a policy for these in the first place; this is defense in
  // depth so a stray call can't deny an exempt channel.
  if (isAdmissionPolicyExemptChannel(input.sourceChannel)) {
    return { admitted: true };
  }

  // Blocked and revoked members never clear admission regardless of floor.
  // Their trust class is already `unknown`, but under a `strangers` floor
  // rank 1 would otherwise clear. The raw-status check keeps the explicit
  // per-channel governance action winning.
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
