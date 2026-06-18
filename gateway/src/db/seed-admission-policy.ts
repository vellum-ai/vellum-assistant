/**
 * Seeds the channel_admission_policy table with one default row per enforced
 * (non-exempt) channel.
 *
 * This is the single source of truth for per-channel default floors. Because
 * rows are seeded at startup, the read paths (store / cache) only need the
 * universal `ADMISSION_POLICY_DEFAULT` fallback — they never re-derive
 * per-channel defaults. Seeding is idempotent and non-destructive: a
 * user-configured row is never overwritten (ON CONFLICT DO NOTHING).
 */

import {
  ADMISSION_POLICY_DEFAULT,
  isAdmissionPolicyHiddenChannel,
  type AdmissionPolicy,
} from "@vellumai/gateway-client";
import { CHANNEL_IDS, type ChannelId } from "../channels/types.js";
import { AdmissionPolicyStore, isExemptChannelType } from "./admission-policy-store.js";

/**
 * Per-channel default floors. Channels absent from this map default to
 * `ADMISSION_POLICY_DEFAULT` (`trusted_contacts`).
 *
 * `vellum` (the local desktop/web client) defaults to `guardian_only`: only
 * the guardian's own local client is admitted by default. The guardian is
 * always max-rank on vellum, so this never locks them out.
 */
export const CHANNEL_ADMISSION_DEFAULTS: Partial<Record<ChannelId, AdmissionPolicy>> = {
  vellum: "guardian_only",
};

/**
 * Insert a default row for every enforced channel that has none. Exempt
 * channels (`platform`/`a2a`/`phone`) are skipped — they carry no floor.
 *
 * Hidden channels (`vellum`/`whatsapp`) are not surfaced in the Channel Trust
 * Floors UI, so a legacy or stale row would strand the channel at a floor the
 * user can no longer see or reset. They are pinned to their default here,
 * overwriting any drifted row — unlike the non-destructive `seedDefault` used
 * for configurable channels.
 */
export function seedAdmissionPolicyDefaults(store: AdmissionPolicyStore): void {
  for (const channelType of CHANNEL_IDS) {
    if (isExemptChannelType(channelType)) continue;
    const policy =
      CHANNEL_ADMISSION_DEFAULTS[channelType] ?? ADMISSION_POLICY_DEFAULT;
    store.seedDefault(channelType, policy);
    // Hidden channels aren't surfaced in the UI, so a legacy/stale row would
    // strand them at a floor the user can't reset. `seedDefault` above is
    // non-destructive, so overwrite any drift back to the default here.
    if (
      isAdmissionPolicyHiddenChannel(channelType) &&
      store.get(channelType) !== policy
    ) {
      store.set(channelType, policy);
    }
  }
}
