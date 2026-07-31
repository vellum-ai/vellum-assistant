import {
  ADMISSION_POLICY_DEFAULT,
  AdmissionPolicyStore,
  type AdmissionPolicy,
} from "../db/admission-policy-store.js";
import { isChannelId, type ChannelId } from "../channels/types.js";
import { isAdmissionPolicyExemptChannel } from "@vellumai/gateway-client";
import { isFeatureFlagEnabled } from "../feature-flag-resolver.js";

// ---------------------------------------------------------------------------
// Cache class
// ---------------------------------------------------------------------------

/**
 * In-memory cache of per-channel admission policies. Mirrors
 * {@link import("./trust-rule-cache.js").initTrustRuleCache} — load once at
 * startup, hit by `handle-inbound` on every inbound, refresh on mutation via
 * {@link invalidateAdmissionPolicyCache}.
 *
 * Per-channel defaults are owned by the startup seed
 * (`seedAdmissionPolicyDefaults`), so the cache holds only what's in the DB
 * and does not re-derive defaults.
 */
class AdmissionPolicyCache {
  private store: AdmissionPolicyStore;
  private policies: Map<ChannelId, AdmissionPolicy> = new Map();

  constructor(store: AdmissionPolicyStore) {
    this.store = store;
    this.refresh();
  }

  refresh(): void {
    this.policies.clear();
    for (const row of this.store.list()) {
      this.policies.set(row.channelType, row.policy);
    }
  }

  /**
   * Resolve the policy for a channel. Rows are seeded for every enforced
   * channel, so this normally hits the map; the `ADMISSION_POLICY_DEFAULT`
   * fallback is a safety net for a channel that has no row yet (e.g. one
   * added between releases, before the next seed runs).
   */
  get(channelType: ChannelId): AdmissionPolicy {
    return this.policies.get(channelType) ?? ADMISSION_POLICY_DEFAULT;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let cache: AdmissionPolicyCache | null = null;

export function initAdmissionPolicyCache(store?: AdmissionPolicyStore): void {
  cache = new AdmissionPolicyCache(store ?? new AdmissionPolicyStore());
}

export function getAdmissionPolicyCache(): AdmissionPolicyCache {
  if (!cache)
    throw new Error(
      "Admission policy cache not initialized — call initAdmissionPolicyCache() at startup",
    );
  return cache;
}

export function invalidateAdmissionPolicyCache(): void {
  cache?.refresh();
}

export function resetAdmissionPolicyCache(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

// Gates all per-channel admission enforcement (kill switch + floor). When off,
// no admission policy is resolved, so inbound falls back to the pre-feature
// ACL-only behavior.
export const CHANNEL_TRUST_FLOORS_FLAG = "channel-trust-floors" as const;

/**
 * Resolve a channel's admission policy, folding the feature-flag gate, the
 * §8.1 exempt-channel skip, and the channel-id guard. Returns `null` when the
 * flag is off, the channel is exempt, or the string is not a known channel —
 * the single source of truth for every admission-policy call site.
 */
export function resolveAdmissionPolicy(
  channelType: string,
): AdmissionPolicy | null {
  if (!isFeatureFlagEnabled(CHANNEL_TRUST_FLOORS_FLAG)) return null;
  if (isAdmissionPolicyExemptChannel(channelType)) return null;
  if (!isChannelId(channelType)) return null;
  return getAdmissionPolicyCache().get(channelType);
}
