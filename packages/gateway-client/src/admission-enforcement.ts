/**
 * Shared admission-floor enforcement: the single implementation of
 * `TRUST_CLASS_RANK >= ADMISSION_FLOOR`.
 *
 * Evaluated by the runtime admission stage (for messages) and by the channel
 * conversation reset endpoint (for gateway-terminal commands like `/new`), so
 * a command clears exactly the decision a message would. Capabilities are NOT
 * computed here; that axis stays in `assistant/src/runtime/capabilities.ts`.
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
  /** Loose to match the wire verdict's `status`; the runtime narrows it. */
  memberStatus: string | undefined;
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
      /** Fire the re-verification upgrade UX (Slack DM / email forwarder). */
      shouldChallenge: boolean;
      effectivePolicy: AdmissionPolicy;
    };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Higher rank = more trusted. Blocked/revoked deny before this comparison. */
export const TRUST_CLASS_RANK: Record<TrustClass, number> = {
  guardian: 4,
  trusted_contact: 3,
  unverified_contact: 2,
  unknown: 1,
};

/**
 * Floors that verification could lift a sender past. `unverified_contact`
 * (rank 2) reaches `any_contact` and `strangers`; below those it stays short.
 */
const POLICIES_THAT_COULD_UPGRADE: ReadonlySet<AdmissionPolicy> = new Set([
  "any_contact",
  "strangers",
]);

/** Pure: all I/O happens in the caller, which wires up its own deny UX. */
export function enforceAdmissionPolicy(
  input: AdmissionPolicyInput,
): AdmissionPolicyResult {
  // Defense in depth: callers should not resolve a policy for exempt
  // channels, so a stray call must not deny one.
  if (isAdmissionPolicyExemptChannel(input.sourceChannel)) {
    return { admitted: true };
  }

  // Explicit governance outranks the floor: rank 1 would otherwise clear a
  // `strangers` floor.
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
