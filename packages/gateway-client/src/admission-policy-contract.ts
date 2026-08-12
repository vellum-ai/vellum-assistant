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

import type { TrustClass } from "./trust-verdict-contract.js";

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
 *
 * `discord` has no ingress implementation, so there is nothing for a floor to
 * gate and nothing for the user to configure. Hiding keeps it pinned at the
 * seed default rather than offering a Channel Trust Floors row for a channel
 * that receives nothing.
 */
export const ADMISSION_POLICY_HIDDEN_CHANNELS: ReadonlySet<string> = new Set([
  "vellum",
  "whatsapp",
  "discord",
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

/**
 * Trust-class ordinal compared against {@link ADMISSION_FLOOR} to make the
 * admission decision. Higher rank = more trusted. Blocked and revoked members
 * never reach this comparison, short-circuiting to deny on member status, so
 * they carry no rank.
 */
export const TRUST_CLASS_RANK: Record<TrustClass, number> = {
  guardian: 4,
  trusted_contact: 3,
  unverified_contact: 2,
  unknown: 1,
};

/**
 * Whether a sender of this trust class clears a channel's admission floor.
 *
 * The two halves of the check live together because they are meaningless
 * apart: this compares a table keyed by {@link TrustClass} against one keyed
 * by {@link AdmissionPolicy}, and a floor added to one without a rank in the
 * other silently admits or denies everyone.
 *
 * Both enforcement points read this. The runtime's admission stage answers for
 * every channel it receives; the gateway answers for a channel it delivers
 * somewhere other than the runtime, where there is no later stage to ask.
 */
export function meetsAdmissionFloor(
  policy: AdmissionPolicy,
  trustClass: TrustClass,
): boolean {
  return TRUST_CLASS_RANK[trustClass] >= ADMISSION_FLOOR[policy];
}
