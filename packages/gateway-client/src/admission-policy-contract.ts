/**
 * Shared admission policy vocabulary used on the gateway→runtime wire.
 *
 * Both the gateway (channel admission policy storage + kill switch) and the
 * runtime (admission-policy stage) consume these values. Keeping the type
 * here avoids the runtime importing from `gateway/src` and avoids the
 * vocabulary drift the plan §2.1 flags for the verification-purpose
 * `trustClass` enum.
 */

import { z } from "zod";

/**
 * Per-channel inbound admission policy — ordered from most-restrictive
 * (`no_one`, hard kill switch) to most-permissive (`strangers`, admits any
 * sender). See `unverified-contact-role-plan.md` §2.3.
 */
export const ADMISSION_POLICY_VALUES = [
  "no_one",
  "guardian_only",
  "trusted_contacts",
  "any_contact",
  "strangers",
] as const;

export type AdmissionPolicy = (typeof ADMISSION_POLICY_VALUES)[number];

export const AdmissionPolicySchema = z.enum(ADMISSION_POLICY_VALUES);

/**
 * Read-side default applied when a channel has no row in the DB. Matches
 * today's effective semantics: guardian + active contacts admitted,
 * strangers denied. See plan §2.2.
 */
export const ADMISSION_POLICY_DEFAULT: AdmissionPolicy = "trusted_contacts";

/**
 * Minimum trust rank required for each policy. Higher rank = more trusted.
 * `no_one` is 5 — above the maximum guardian rank (4) — so no class is ever
 * admitted. See plan §2.4 for the rank table.
 */
export const ADMISSION_FLOOR: Record<AdmissionPolicy, number> = {
  no_one: 5,
  guardian_only: 4,
  trusted_contacts: 3,
  any_contact: 2,
  strangers: 1,
};

/**
 * Hard-exempt internal channels — never subject to PUT policy, omitted from
 * GET list, runtime admission stage short-circuits without floor check,
 * gateway kill switch skips the `no_one` check. See wave-b §8.1.
 *
 * Reason: prevents a guardian from accidentally configuring `no_one` for
 * the `vellum` channel and locking themselves out of their own client.
 */
export const ADMISSION_POLICY_EXEMPT_CHANNELS: ReadonlySet<string> = new Set([
  "vellum",
  "platform",
  "a2a",
]);

export function isAdmissionPolicyExemptChannel(channelType: string): boolean {
  return ADMISSION_POLICY_EXEMPT_CHANNELS.has(channelType);
}

export function isAdmissionPolicy(value: unknown): value is AdmissionPolicy {
  return (
    typeof value === "string" &&
    (ADMISSION_POLICY_VALUES as readonly string[]).includes(value)
  );
}
