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
 * GET list, runtime admission stage short-circuits without floor check.
 *
 * `platform` / `a2a` are peer/internal channels with no human-trust model.
 *
 * `phone` is NOT exempt — voice ingress enforces the admission floor.
 *
 * `vellum` / `whatsapp` are NOT exempt — their floors are still enforced at
 * runtime — but they are hidden from the configurable UI; see
 * {@link ADMISSION_POLICY_HIDDEN_CHANNELS}.
 */
export const ADMISSION_POLICY_EXEMPT_CHANNELS: ReadonlySet<string> = new Set([
  "platform",
  "a2a",
]);

export function isAdmissionPolicyExemptChannel(channelType: string): boolean {
  return ADMISSION_POLICY_EXEMPT_CHANNELS.has(channelType);
}

/**
 * Channels omitted from the Channel Trust Floors list (GET) and rejected on
 * PUT/DELETE — managed automatically at their seed default, not user
 * configurable. Unlike {@link ADMISSION_POLICY_EXEMPT_CHANNELS} they are still
 * enforced at runtime, so hiding a real inbound channel like `whatsapp` never
 * silently disables its admission floor check. The startup seed re-pins any
 * drifted row so a stale floor (e.g. a legacy `no_one`) can't strand a channel
 * the user can no longer see.
 *
 * `vellum` is the local desktop/web client surface; the guardian is always
 * max-rank there, so the seed default admits them regardless of the floor.
 */
export const ADMISSION_POLICY_HIDDEN_CHANNELS: ReadonlySet<string> = new Set([
  "vellum",
  "whatsapp",
]);

export function isAdmissionPolicyHiddenChannel(channelType: string): boolean {
  return ADMISSION_POLICY_HIDDEN_CHANNELS.has(channelType);
}

export function isAdmissionPolicy(value: unknown): value is AdmissionPolicy {
  return (
    typeof value === "string" &&
    (ADMISSION_POLICY_VALUES as readonly string[]).includes(value)
  );
}
