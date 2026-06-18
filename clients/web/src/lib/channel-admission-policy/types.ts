/**
 * Shared types for the per-channel admission policy. Mirrors
 * `gateway/src/db/admission-policy-store.ts` and the Swift
 * `ChannelAdmissionPolicy` types so cross-surface names stay in lockstep.
 */

export const ADMISSION_POLICY_VALUES = [
  "no_one",
  "guardian_only",
  "trusted_contacts",
  "any_contact",
  "strangers",
] as const;

export type AdmissionPolicy = (typeof ADMISSION_POLICY_VALUES)[number];

export const ADMISSION_POLICY_DEFAULT: AdmissionPolicy = "trusted_contacts";

/**
 * Channels the user cannot configure at all. `platform` is the vembda-managed
 * control plane, `a2a` is peer-to-peer assistant traffic — neither has a
 * human-trust model. (`vellum` IS configurable; see
 * {@link KILL_SWITCH_FORBIDDEN_CHANNELS}.)
 */
export const INTERNAL_CHANNELS = new Set<string>(["platform", "a2a"]);

/**
 * Channels that are configurable but may not be set to `no_one`. `vellum` is
 * the local desktop/web client surface — a `no_one` kill switch there would
 * lock the guardian out of their own app, so the picker omits that option.
 */
export const KILL_SWITCH_FORBIDDEN_CHANNELS = new Set<string>(["vellum"]);

export function isKillSwitchForbiddenChannel(channelType: string): boolean {
  return KILL_SWITCH_FORBIDDEN_CHANNELS.has(channelType);
}

export interface ChannelPolicyView {
  channelType: string;
  policy: AdmissionPolicy;
  note: string | null;
  updatedAt: number | null;
}

export const POLICY_LABELS: Record<AdmissionPolicy, string> = {
  no_one: "No one (kill switch)",
  guardian_only: "Guardian only",
  trusted_contacts: "Trusted contacts",
  any_contact: "Any contact",
  strangers: "Strangers",
};

export const POLICY_DESCRIPTIONS: Record<AdmissionPolicy, string> = {
  no_one: "Hard-deny every inbound message on this channel.",
  guardian_only: "Only messages from the guardian are admitted.",
  trusted_contacts:
    "Admit verified contacts and the guardian; deny everyone else.",
  any_contact:
    "Admit any matched contact (verified or pending) and the guardian.",
  strangers: "Admit everyone, including unrecognised senders.",
};
