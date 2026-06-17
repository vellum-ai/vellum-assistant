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

import { ADMISSION_POLICY_DEFAULT, type AdmissionPolicy } from "@vellumai/gateway-client";
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
 */
export function seedAdmissionPolicyDefaults(store: AdmissionPolicyStore): void {
  for (const channelType of CHANNEL_IDS) {
    if (isExemptChannelType(channelType)) continue;
    store.seedDefault(
      channelType,
      CHANNEL_ADMISSION_DEFAULTS[channelType] ?? ADMISSION_POLICY_DEFAULT,
    );
  }
}
