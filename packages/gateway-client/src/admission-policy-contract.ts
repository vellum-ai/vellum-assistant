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
 * gateway kill switch skips the `no_one` check.
 *
 * `platform` / `a2a` are peer/internal channels with no human-trust model.
 *
 * NOTE: `phone` is exempt because the Twilio voice-webhook path
 * (twilio-voice-webhook → relay-setup-router) does not yet read
 * AdmissionPolicyStore / sourceMetadata.admissionPolicy. Storing a policy for
 * `phone` would have no runtime effect, so we exclude it from the API surface
 * until voice ingress is wired in a follow-up PR. Remove `"phone"` from this
 * set once the voice path enforces admission.
 *
 * `vellum` is intentionally NOT exempt — it is client-configurable, with the
 * single restriction in {@link KILL_SWITCH_FORBIDDEN_CHANNELS}.
 */
export const ADMISSION_POLICY_EXEMPT_CHANNELS: ReadonlySet<string> = new Set([
  "platform",
  "a2a",
  "phone",
]);

export function isAdmissionPolicyExemptChannel(channelType: string): boolean {
  return ADMISSION_POLICY_EXEMPT_CHANNELS.has(channelType);
}

/**
 * Channels that are configurable but may never be set to `no_one` (the kill
 * switch). `vellum` is the local desktop/web client channel; allowing `no_one`
 * there would let the guardian lock themselves out of their own client. The
 * guardian is always classified `guardian` (max rank) on vellum, so every
 * floor except `no_one` still admits them — only the kill switch is forbidden.
 */
export const KILL_SWITCH_FORBIDDEN_CHANNELS: ReadonlySet<string> = new Set([
  "vellum",
]);

export function isKillSwitchForbiddenChannel(channelType: string): boolean {
  return KILL_SWITCH_FORBIDDEN_CHANNELS.has(channelType);
}

export function isAdmissionPolicy(value: unknown): value is AdmissionPolicy {
  return (
    typeof value === "string" &&
    (ADMISSION_POLICY_VALUES as readonly string[]).includes(value)
  );
}
