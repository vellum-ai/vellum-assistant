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
 * {@link import("./trust-rule-cache.js").initTrustRuleCache} — load once
 * at startup, hit on every inbound, refresh on mutation via
 * {@link invalidateAdmissionPolicyCache}.
 *
 * Nothing reads from this cache in P2 — it's wired up here so the P3
 * `handle-inbound` admission gate has zero new infrastructure to land. The
 * read path (`get`) and the invalidation hook (called from the HTTP routes)
 * are the seam.
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
   * Resolve the policy for a channel. Missing rows fall back to the
   * read-side default (matches `AdmissionPolicyStore.get`).
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
