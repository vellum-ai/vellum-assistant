import type {
    CreditTier,
    CreditTierEnum,
    MachineTier,
    StorageTier,
    SubscriptionStatusEnum,
} from "@/generated/api/types.gen";
import { isTierDisabled } from "./tier-picker";

/**
 * Subscription statuses for which Pro tier changes are permitted. Mirrors the
 * backend `ENTITLEMENT_BEARING_STATUSES` (subscription_service.py) that
 * `is_pro_active` (app/billing/entitlements.py) checks — the
 * `change_machine_tier` / `change_storage_tier` endpoints return 403 for any
 * other status. Pro orgs in non-entitlement statuses (`unpaid`, `incomplete`,
 * `paused`, etc.) must not be shown a tier-change CTA that cannot succeed.
 */
export const TIER_CHANGE_ELIGIBLE_STATUSES: ReadonlySet<SubscriptionStatusEnum> =
  new Set<SubscriptionStatusEnum>(["active", "trialing", "past_due"]);

/**
 * Extract a user-facing message from a subscription mutation error.
 *
 * DRF field errors arrive as `{ field_name: [message, ...] }`; we probe the
 * known fields and fall back to `detail` then a caller-provided generic.
 */
const DRF_FIELD_KEYS = [
  "target_plan_id",
  "confirm",
  "machine_tier",
  "storage_tier",
  "credit_tier",
  "non_field_errors",
] as const;

export function extractMutationError(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    for (const key of DRF_FIELD_KEYS) {
      if (key in error) {
        const msgs = (error as Record<string, unknown>)[key];
        if (Array.isArray(msgs) && typeof msgs[0] === "string") {
          return msgs[0];
        }
      }
    }
    if ("detail" in error && typeof error.detail === "string") {
      return error.detail;
    }
  }
  return fallback;
}

/**
 * Resolve which tier should be selected given the user's previous choice and
 * the current tier list. Keeps `prev` only if it is still present AND enabled;
 * otherwise falls back to the first enabled tier (or null when none qualify).
 *
 * Revalidating against the live list guards the case where a plans refetch
 * removes or disables the previously-selected tier while the modal is open —
 * the CTA's non-null gate alone would otherwise let the user submit a stale or
 * now-disabled tier that the server rejects.
 */
export function resolveTierSelection<T extends string>(
  tiers: (MachineTier | StorageTier)[],
  prev: T | null,
): T | null {
  const enabled = tiers.filter((t) => !isTierDisabled(t));
  if (prev !== null && enabled.some((t) => t.tier === prev)) {
    return prev;
  }
  return (enabled[0]?.tier ?? null) as T | null;
}

/**
 * Resolve which credit tier should be selected given the previous selection,
 * the resolved current bundle, and the live catalog. Mirrors
 * `resolveTierSelection` but for credit bundles, which have no disabled state
 * and where both `null` ("No bundle") and a catalog tier are valid selections.
 *
 * `prev` carries the sentinel meaning:
 *   - `undefined` is un-seeded (the effect has not yet seeded a value), so we
 *     seed to `current`. The seed is preserved verbatim — including a non-null
 *     current tier that the live catalog does not (yet) advertise (e.g. a
 *     deprecated tier the user still holds). Coercing such a tier to `null`
 *     would make `creditChanged` read true purely from opening the modal and
 *     silently submit `credit_tier: null`, removing a paid bundle the user
 *     never touched. Preserving it keeps `creditChanged` false until the user
 *     actively changes the selection.
 *   - a non-undefined `prev` (including an explicit `null` for "No bundle") is
 *     the user's standing choice and must be preserved — we keep it, only
 *     coercing a concrete tier to "No bundle" when it is BOTH absent from the
 *     catalog AND not the held current bundle. A held-but-delisted tier (equal
 *     to `current`) survives a mid-modal refetch; only a genuinely stale choice
 *     (a delisted tier the user actively picked) falls back to "No bundle" so
 *     the CTA never submits a tier the catalog no longer offers.
 */
export function resolveCreditTierSelection(
  tiers: CreditTier[],
  prev: CreditTierEnum | null | undefined,
  current: CreditTierEnum | null,
): CreditTierEnum | null {
  if (prev === undefined) {
    return current;
  }
  if (prev !== null && (prev === current || tiers.some((t) => t.tier === prev))) {
    return prev;
  }
  return null;
}

/**
 * Cheapest tier price in cents, or 0 when the list is empty. Guards the
 * "From $" summary against `Math.min(...[])` → `Infinity` (which would render
 * "From $Infinity"). Production plans always carry populated tier arrays, so
 * this only matters defensively.
 */
export function minTierPriceCents(tiers: (MachineTier | StorageTier)[]): number {
  return tiers.length ? Math.min(...tiers.map((t) => t.price_cents)) : 0;
}
