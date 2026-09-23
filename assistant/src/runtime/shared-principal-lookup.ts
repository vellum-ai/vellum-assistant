/**
 * Trust-class lookup for a shared-conversation principal.
 *
 * `local-principal-trust.ts` asks the gateway one question about a `vellum`
 * principal (is it the guardian?), so it cannot classify a contact. Contacts
 * in shared conversations live on the `vellum-shared` channel, and this module
 * asks the question every other channel asks: the gateway's canonical
 * per-actor classifier (`resolve_inbound_trust`, reached through
 * {@link readInboundTrust}), with `vellum-shared` as the channel and the
 * principal as the actor id. Classification stays gateway-owned; nothing
 * here re-derives it from ACL rows.
 *
 * Results are cached per principal behind a short TTL and coalesced
 * single-flight: the callers this exists for run per request, where
 * {@link readInboundTrust} caches nothing because it serves call setup. A
 * revoked contact keeps resolving from cache until the entry expires; callers
 * that cannot tolerate that read {@link resolveSharedPrincipalFresh}.
 *
 * Failures resolve `unknown` and are not cached: an unreachable gateway, a
 * malformed response, and the resolver's own could-not-vouch sentinel all
 * fail closed and are retried on the next call.
 */

import type { TrustClass } from "@vellumai/gateway-client";

import { readInboundTrust } from "../calls/inbound-trust-reader.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("shared-principal-lookup");

/** Bounds staleness after a revoke; callers needing none read fresh. */
const CACHE_TTL_MS = 30_000;

/** Keeps the map from growing without limit across principals. */
export const MAX_ENTRIES = 2000;

export interface SharedPrincipalTrust {
  trustClass: TrustClass;
  contactId?: string;
  displayName?: string;
}

// Frozen: returned to every failing caller, so a mutation would travel.
const UNKNOWN: SharedPrincipalTrust = Object.freeze({ trustClass: "unknown" });

interface PrincipalState {
  trust?: SharedPrincipalTrust;
  expiresAt?: number;
  inFlight?: Promise<SharedPrincipalTrust>;
  /** Bumped when a read starts; only the newest read may write its result. */
  generation: number;
  /** Reads currently in flight for this principal. */
  active: number;
}

const states = new Map<string, PrincipalState>();

function stateFor(principalId: string): PrincipalState {
  const existing = states.get(principalId);
  if (existing) {
    return existing;
  }
  const created: PrincipalState = { generation: 0, active: 0 };
  states.set(principalId, created);
  return created;
}

/** Drops a principal holding neither a cached verdict nor a live read. */
function prune(principalId: string): void {
  const state = states.get(principalId);
  if (state && state.active === 0 && state.trust === undefined) {
    states.delete(principalId);
  }
}

/**
 * Evicts idle principals, oldest first, until the map holds at most `limit`.
 *
 * A burst of distinct principals can push the map past MAX_ENTRIES: every
 * entry is mid-read, so nothing is evictable, and the insert happens anyway
 * rather than refusing the caller. Nothing else would bring the map back
 * down, so every settling read trims too, not just the next insert.
 */
function trimTo(limit: number): void {
  if (states.size <= limit) {
    return;
  }
  for (const [key, state] of states) {
    if (state.active > 0) {
      continue;
    }
    states.delete(key);
    if (states.size <= limit) {
      return;
    }
  }
}

/** Makes room for a principal the map does not hold yet. */
function evictIfFull(principalId: string): void {
  if (states.has(principalId)) {
    return;
  }
  trimTo(MAX_ENTRIES - 1);
}

async function fetchTrust(
  principalId: string,
): Promise<{ trust: SharedPrincipalTrust; cacheable: boolean }> {
  const result = await readInboundTrust({
    channelType: "vellum-shared",
    actorExternalId: principalId,
  });

  if (!result.ok) {
    log.warn(
      { principalId },
      "shared principal trust unresolved: gateway read failed",
    );
    return { trust: UNKNOWN, cacheable: false };
  }

  const { verdict } = result;

  if (verdict.resolutionFailed) {
    log.warn(
      { principalId },
      "shared principal trust unresolved: gateway could not vouch",
    );
    return { trust: UNKNOWN, cacheable: false };
  }

  const trust: SharedPrincipalTrust = { trustClass: verdict.trustClass };
  if (verdict.contactId !== undefined) {
    trust.contactId = verdict.contactId;
  }
  const displayName = verdict.memberDisplayName ?? verdict.guardianDisplayName;
  if (displayName !== undefined) {
    trust.displayName = displayName;
  }
  return { trust, cacheable: true };
}

function read(
  principalId: string,
  forceRefresh: boolean,
): Promise<SharedPrincipalTrust> {
  const key = principalId.trim();
  if (!key) {
    return Promise.resolve(UNKNOWN);
  }

  if (!forceRefresh) {
    const cached = states.get(key);
    if (
      cached?.trust &&
      cached.expiresAt !== undefined &&
      cached.expiresAt > Date.now()
    ) {
      return Promise.resolve(cached.trust);
    }
    if (cached?.inFlight) {
      return cached.inFlight;
    }
  }

  evictIfFull(key);
  const state = stateFor(key);
  state.generation += 1;
  state.active += 1;
  const generation = state.generation;

  const promise = fetchTrust(key)
    .then(({ trust, cacheable }) => {
      // A read that started earlier must not overwrite a newer verdict: a
      // fresh read racing an in-flight cached read would otherwise restore
      // the pre-revoke answer for the rest of the TTL.
      if (cacheable && state.generation === generation) {
        state.trust = trust;
        state.expiresAt = Date.now() + CACHE_TTL_MS;
      }
      return trust;
    })
    .finally(() => {
      state.active -= 1;
      if (state.inFlight === promise) {
        state.inFlight = undefined;
      }
      prune(key);
      trimTo(MAX_ENTRIES);
    });

  if (!forceRefresh) {
    state.inFlight = promise;
  }
  return promise;
}

/**
 * Trust class for a shared-conversation principal, from cache when fresh.
 * Resolves `unknown` for an unknown, revoked, or blocked principal, and for
 * any read the gateway could not complete.
 */
export function resolveSharedPrincipal(
  principalId: string,
): Promise<SharedPrincipalTrust> {
  return read(principalId, false);
}

/**
 * Uncached variant of {@link resolveSharedPrincipal}, for callers whose threat
 * model is the stale entry itself. Repopulates the cache on success.
 */
export function resolveSharedPrincipalFresh(
  principalId: string,
): Promise<SharedPrincipalTrust> {
  return read(principalId, true);
}

/** Test-only: number of principals currently held. */
export function __sharedPrincipalCacheSizeForTest(): number {
  return states.size;
}

/** Test-only: reset cache + in-flight state for deterministic test runs. */
export function __resetSharedPrincipalCacheForTest(): void {
  states.clear();
}
