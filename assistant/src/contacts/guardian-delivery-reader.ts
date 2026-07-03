/**
 * Gateway-backed guardian binding + delivery reader.
 *
 * Resolves the active guardian binding(s) and their per-channel delivery
 * endpoints from the gateway via the `resolve_guardian_delivery` IPC route,
 * validating the response against {@link ResolveGuardianDeliveryResponseSchema}.
 *
 * Guardian binding is near-static — it only changes on guardian onboarding /
 * verification or revocation — yet this reader sits on many hot paths. To keep
 * those paths off the IPC, results are cached behind a minutes-scale TTL and
 * coalesced single-flight so a cold cache storms the gateway at most once.
 *
 * Freshness comes from two sources: {@link invalidateGuardianDeliveryCache},
 * called on contact mutations to clear the cache, and
 * {@link getGuardianDeliveryFresh} reads on existence guards (gateway-side
 * binding writes don't invalidate the daemon cache, so those paths read fresh).
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
// Tracks whether the in-flight fetch was a force-refresh, so a fresh read never
// coalesces with an older non-force fetch that may predate a gateway-side write.
const inFlight = new Map<
  string,
  { promise: Promise<GuardianDelivery[] | null>; fresh: boolean }
>();

// Bumped on every invalidation. A fetch captures the generation when it starts
// and only writes its result to the cache if the generation is unchanged on
// resolve, so an invalidation mid-flight can't repopulate a stale pre-change
// result and mask a guardian-binding change.
let cacheGeneration = 0;

function cacheKey(channelTypes?: string[]): string {
  if (!channelTypes || channelTypes.length === 0) return "ALL";
  return [...channelTypes].sort().join(",");
}

async function fetchGuardianDelivery(input: {
  channelTypes?: string[];
}): Promise<GuardianDelivery[] | null> {
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

// Shared fetch path for both the cached and fresh public surfaces. When
// `forceRefresh` is set the cached entry is bypassed; the read is still
// single-flight and still populates the cache with the fresh result.
async function readGuardianDelivery(input: {
  channelTypes?: string[];
  forceRefresh?: boolean;
}): Promise<GuardianDelivery[] | null> {
  const key = cacheKey(input.channelTypes);

  if (!input.forceRefresh) {
    const cached = cache.get(key);
    if (
      cached &&
      Date.now() - cached.fetchedAt < GUARDIAN_DELIVERY_CACHE_TTL_MS
    ) {
      return cached.guardians;
    }
  }

  // A non-force read may coalesce with any in-flight fetch. A force read may
  // only coalesce with another force fetch — never with a non-force fetch that
  // could have started before a gateway-side binding write and resolve stale.
  const pending = inFlight.get(key);
  if (pending && (!input.forceRefresh || pending.fresh)) return pending.promise;

  const startGen = cacheGeneration;
  const promise = fetchGuardianDelivery({ channelTypes: input.channelTypes })
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
      // Only clear the slot if it still holds this fetch — a concurrent force
      // read may have replaced a non-force entry (or vice versa).
      if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
    });

  inFlight.set(key, { promise, fresh: !!input.forceRefresh });
  return promise;
}

/**
 * Resolve active guardian deliveries, optionally filtered by channel type.
 * Returns the cached list when fresh, otherwise fetches (single-flight) and
 * caches on success. Returns `null` on failure without caching.
 *
 * To force an uncached read, call {@link getGuardianDeliveryFresh} — the only
 * public fresh-read entry point.
 */
export async function getGuardianDelivery(input?: {
  channelTypes?: string[];
}): Promise<GuardianDelivery[] | null> {
  return readGuardianDelivery({ channelTypes: input?.channelTypes });
}

/**
 * Synchronous read of the already-cached guardian deliveries, without any IO.
 *
 * Returns the fresh cached list for the given channel filter, or `undefined`
 * when the cache is cold or expired. Used by sync hot paths (SSE subscribe)
 * that cannot await {@link getGuardianDelivery} but must resolve the SAME
 * gateway-owned principal the async paths land on. A cold/expired return lets
 * the caller fall back to the local store as before.
 */
export function peekCachedGuardianDelivery(input?: {
  channelTypes?: string[];
}): GuardianDelivery[] | undefined {
  const cached = cache.get(cacheKey(input?.channelTypes));
  if (!cached) return undefined;
  if (Date.now() - cached.fetchedAt >= GUARDIAN_DELIVERY_CACHE_TTL_MS) {
    return undefined;
  }
  return cached.guardians;
}

/**
 * Fresh (uncached) variant of {@link getGuardianDelivery}. Existence guards read
 * fresh because gateway-side binding writes don't invalidate the daemon cache.
 * Still single-flight, and still populates the cache with the fresh result.
 */
export async function getGuardianDeliveryFresh(input?: {
  channelTypes?: string[];
}): Promise<GuardianDelivery[] | null> {
  return readGuardianDelivery({
    channelTypes: input?.channelTypes,
    forceRefresh: true,
  });
}

/**
 * Clear ALL cached guardian deliveries so contact mutations refetch on the next
 * read. Called by {@link notifyContactsChanged} after a contact write, and
 * available to any caller that wants to invalidate explicitly.
 */
export function invalidateGuardianDeliveryCache(): void {
  cacheGeneration += 1;
  cache.clear();
  inFlight.clear();
}

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

/**
 * Resolve a guardian displayName for voice surfaces: prefer the phone-channel
 * guardian, falling back to any guardian. Returns `undefined` when the list is
 * absent or no guardian carries a displayName.
 */
export function voiceGuardianDisplayName(
  list: GuardianDelivery[] | null,
): string | undefined {
  const guardian = list
    ? (guardianForChannel(list, "phone") ?? anyGuardian(list))
    : undefined;
  return guardian?.displayName ?? undefined;
}

/** Test-only: reset cache + in-flight state for deterministic test runs. */
export function __resetGuardianDeliveryCacheForTest(): void {
  cache.clear();
  inFlight.clear();
  cacheGeneration = 0;
}
