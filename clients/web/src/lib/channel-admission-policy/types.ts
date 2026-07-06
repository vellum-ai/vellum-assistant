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
 * human-trust model. (`vellum` is enforced at runtime but hidden from the UI;
 * see {@link HIDDEN_CHANNELS}.)
 */
export const INTERNAL_CHANNELS = new Set<string>(["platform", "a2a"]);

/**
 * Channels that are still enforced at runtime but intentionally hidden from the
 * Channel Trust Floors list. The gateway already omits them from the GET
 * response; we double-filter here so a future gateway regression can't leak
 * them into the UI. Mirrors `ADMISSION_POLICY_HIDDEN_CHANNELS` in
 * `packages/gateway-client/src/admission-policy-contract.ts`.
 */
export const HIDDEN_CHANNELS = new Set<string>(["vellum", "whatsapp"]);

export function isHiddenChannel(channelType: string): boolean {
  return HIDDEN_CHANNELS.has(channelType);
}

export interface ChannelPolicyView {
  channelType: string;
  policy: AdmissionPolicy;
  note: string | null;
  updatedAt: number | null;
}

export const POLICY_LABELS: Record<AdmissionPolicy, string> = {
  no_one: "No one",
  guardian_only: "Only you",
  trusted_contacts: "Verified contacts",
  any_contact: "Any contact",
  strangers: "Strangers",
};

/**
 * Plain-English description of each admission policy, phrased around the
 * assistant's display name (e.g. "Vex" or "your assistant").
 */
export function getPolicyDescriptions(
  assistantDisplayName: string,
): Record<AdmissionPolicy, string> {
  return {
    no_one: `No one can message ${assistantDisplayName} on this channel — every message is blocked, including yours.`,
    guardian_only: `Only you can message ${assistantDisplayName}. Everyone else is turned away.`,
    trusted_contacts: `You and the people you’ve verified can message ${assistantDisplayName}. Anyone else is asked to verify first, and you’re notified.`,
    any_contact: `You and any known contact can message ${assistantDisplayName}, including contacts you haven’t verified yet. Strangers are asked to verify first.`,
    strangers: `Anyone can message ${assistantDisplayName}, including complete strangers.`,
  };
}
