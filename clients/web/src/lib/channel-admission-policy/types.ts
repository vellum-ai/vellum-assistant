/**
 * Shared types for the per-channel admission policy. Mirrors
 * `gateway/src/db/admission-policy-store.ts` so cross-surface names stay
 * in lockstep.
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
