/**
 * Gateway-backed guardian binding + delivery reader.
 *
 * Resolves the active guardian binding(s) and their per-channel delivery
 * endpoints from the gateway via the `resolve_guardian_delivery` IPC route,
 * validating the response against {@link ResolveGuardianDeliveryResponseSchema}.
 *
 * Guardian binding is near-static — it only changes on guardian onboarding /
 * verification or revocation — yet this reader sits on many hot paths. To keep
 * those paths off the IPC, results are cached behind a minutes-scale TTL,
 * cleared event-driven via {@link invalidateGuardianDeliveryCache} (subscribed
 * to contact mutations, and called explicitly by guardian-binding mutations),
 * and coalesced single-flight so a cold cache storms the gateway at most once.
 *
 * Returns `null` on ANY failure (transport failure, malformed shape, timeout,
 * or thrown error); failures are NOT cached, so a recovered gateway is retried
 * on the next call.
 */

import {
  type GuardianDelivery,
  ResolveGuardianDeliveryResponseSchema,
} from "@vellumai/gateway-client";

import { ipcCall } from "../ipc/gateway-client.js";
import { onContactChange } from "./contact-events.js";

// Short IPC timeout so the read resolves promptly rather than stalling a hot
// path on a gateway that accepts the socket but hangs.
const GUARDIAN_DELIVERY_IPC_TIMEOUT_MS = 2_000;

// Guardian binding is near-static, so a minutes-scale TTL is safe; freshness is
// driven primarily by event-based invalidation, not by this backstop expiry.
const GUARDIAN_DELIVERY_CACHE_TTL_MS = 300_000;

interface CacheEntry {
  guardians: GuardianDelivery[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<GuardianDelivery[] | null>>();

// Bumped on every invalidation. A fetch captures the generation when it starts
// and only writes its result to the cache if the generation is unchanged on
// resolve, so an invalidation mid-flight can't repopulate a stale pre-change
// result and mask a guardian-binding change.
let cacheGeneration = 0;

function cacheKey(channelTypes?: string[]): string {
  if (!channelTypes || channelTypes.length === 0) return "ALL";
  return [...channelTypes].sort().join(",");
}

async function fetchGuardianDelivery(
  input: { channelTypes?: string[] },
): Promise<GuardianDelivery[] | null> {
  try {
    const result = await ipcCall(
      "resolve_guardian_delivery",
      input,
      GUARDIAN_DELIVERY_IPC_TIMEOUT_MS,
    );
    if (!result) return null;

    const parsed = ResolveGuardianDeliveryResponseSchema.safeParse(result);
    return parsed.success ? parsed.data.guardians : null;
  } catch {
    return null;
  }
}

/**
 * Resolve active guardian deliveries, optionally filtered by channel type.
 * Returns the cached list when fresh, otherwise fetches (single-flight) and
 * caches on success. Returns `null` on failure without caching.
 *
 * Pass `forceRefresh` to bypass the cached entry and fetch fresh — still
 * single-flight, and still populates the cache with the fresh result. Used by
 * existence guards, since gateway-side binding writes don't invalidate the
 * daemon cache.
 */
export async function getGuardianDelivery(
  input?: { channelTypes?: string[]; forceRefresh?: boolean },
): Promise<GuardianDelivery[] | null> {
  const key = cacheKey(input?.channelTypes);

  if (!input?.forceRefresh) {
    const cached = cache.get(key);
    if (
      cached &&
      Date.now() - cached.fetchedAt < GUARDIAN_DELIVERY_CACHE_TTL_MS
    ) {
      return cached.guardians;
    }
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const startGen = cacheGeneration;
  const promise = fetchGuardianDelivery({ channelTypes: input?.channelTypes })
    .then((guardians) => {
      // Skip the write if an invalidation fired during the fetch: the result
      // may predate the change. Return it to this caller (freshest it has) but
      // leave the cache empty so the next call re-fetches.
      if (guardians && cacheGeneration === startGen) {
        cache.set(key, { guardians, fetchedAt: Date.now() });
      }
      return guardians;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

/**
 * Fresh (uncached) variant of {@link getGuardianDelivery}. Existence guards read
 * fresh because gateway-side binding writes don't invalidate the daemon cache.
 */
export async function getGuardianDeliveryFresh(
  input?: { channelTypes?: string[] },
): Promise<GuardianDelivery[] | null> {
  return getGuardianDelivery({ ...input, forceRefresh: true });
}

/**
 * Clear ALL cached guardian deliveries. Called event-driven on contact
 * mutations, and must also be called from guardian-binding mutation sites
 * (gateway onboarding / verification / revocation) so the next read refetches.
 */
export function invalidateGuardianDeliveryCache(): void {
  cacheGeneration += 1;
  cache.clear();
  inFlight.clear();
}

onContactChange(invalidateGuardianDeliveryCache);

/** First active guardian delivery for the given channel type, if any. */
export function guardianForChannel(
  list: GuardianDelivery[],
  channelType: string,
): GuardianDelivery | undefined {
  return list.find(
    (g) => g.channelType === channelType && g.status === "active",
  );
}

/** First guardian delivery overall — the `listGuardianChannels` fallback. */
export function anyGuardian(
  list: GuardianDelivery[],
): GuardianDelivery | undefined {
  return list[0];
}

/** Test-only: reset cache + in-flight state for deterministic test runs. */
export function __resetGuardianDeliveryCacheForTest(): void {
  cache.clear();
  inFlight.clear();
  cacheGeneration = 0;
}
