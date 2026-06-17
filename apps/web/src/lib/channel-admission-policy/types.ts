/**
 * Shared types for the per-channel admission policy + per-conversation
 * override. Mirrors `gateway/src/db/admission-policy-store.ts` and the
 * Swift `ChannelAdmissionPolicy` types so cross-surface names stay in
 * lockstep.
 */

export const ADMISSION_POLICY_VALUES = [
  "no_one",
  "guardian_only",
  "trusted_contacts",
  "any_contact",
  "strangers",
] as const;

export type AdmissionPolicy = (typeof ADMISSION_POLICY_VALUES)[number];

/**
 * Numeric floor for each policy. Higher = more restrictive. Used purely
 * for the client-side divergence warning in the per-conversation picker —
 * the gateway is still the authority on actual admission decisions.
 */
export const ADMISSION_FLOOR: Record<AdmissionPolicy, number> = {
  no_one: 5,
  guardian_only: 4,
  trusted_contacts: 3,
  any_contact: 2,
  strangers: 1,
};

export const ADMISSION_POLICY_DEFAULT: AdmissionPolicy = "trusted_contacts";

/**
 * §8.1 — channels the user cannot configure. `vellum` is the local
 * desktop/web client surface, `platform` is the vembda-managed control
 * plane, `a2a` is peer-to-peer assistant traffic. Locking any of these
 * would brick the user's own desktop app or platform connection.
 */
export const INTERNAL_CHANNELS = new Set<string>([
  "vellum",
  "platform",
  "a2a",
]);

export interface ChannelPolicyView {
  channelType: string;
  policy: AdmissionPolicy;
  note: string | null;
  updatedAt: number | null;
}

export interface ConversationOverrideView {
  conversationId: string;
  channelType: string | null;
  override: AdmissionPolicy | null;
  typeFloor: AdmissionPolicy;
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

/**
 * `true` iff applying `candidate` as a per-conversation override would
 * *widen* the inbound surface relative to the channel-type floor — i.e.
 * admit MORE senders than the type default would. The §8.3 inline
 * warning fires only in that direction.
 */
export function isLessRestrictiveThanTypeFloor(
  candidate: AdmissionPolicy,
  typeFloor: AdmissionPolicy,
): boolean {
  return ADMISSION_FLOOR[candidate] < ADMISSION_FLOOR[typeFloor];
}
