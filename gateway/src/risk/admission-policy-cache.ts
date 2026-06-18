import {
  ADMISSION_POLICY_DEFAULT,
  AdmissionPolicyStore,
  type AdmissionPolicy,
} from "../db/admission-policy-store.js";
import type { ChannelId } from "../channels/types.js";

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
