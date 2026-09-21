/**
 * Trust-class lookup for a `vellum` principal.
 *
 * `local-principal-trust.ts` asks the gateway one question about a `vellum`
 * principal (is it the guardian?), so a principal belonging to a contact
 * resolves `unknown`. This module asks the question every other channel asks:
 * the gateway's canonical per-actor classifier (`resolve_inbound_trust`,
 * reached through {@link readInboundTrust}), with `vellum` as the channel and
 * the principal as the actor id. Classification stays gateway-owned; nothing
 * here re-derives it from ACL rows.
 *
 * Results are cached per principal behind a short TTL and coalesced
 * single-flight: the callers this exists for run per request, where
 * {@link readInboundTrust} caches nothing because it serves call setup. A
 * revoked contact keeps resolving from cache until the entry expires; callers
 * that cannot tolerate that read {@link resolveVellumPrincipalFresh}.
 *
 * Failures resolve `unknown` and are not cached: an unreachable gateway, a
 * malformed response, and the resolver's own could-not-vouch sentinel all
 * fail closed and are retried on the next call.
 */

import type { TrustClass } from "@vellumai/gateway-client";

import { readInboundTrust } from "../calls/inbound-trust-reader.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("vellum-principal-lookup");

/** Bounds staleness after a revoke; callers needing none read fresh. */
const CACHE_TTL_MS = 30_000;

/** Keeps the map from growing without limit across principals. */
const MAX_ENTRIES = 2000;

export interface VellumPrincipalTrust {
  trustClass: TrustClass;
  contactId?: string;
  displayName?: string;
}

// Frozen: returned to every failing caller, so a mutation would travel.
const UNKNOWN: VellumPrincipalTrust = Object.freeze({ trustClass: "unknown" });

interface PrincipalState {
  trust?: VellumPrincipalTrust;
  expiresAt?: number;
  inFlight?: Promise<VellumPrincipalTrust>;
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

/** Evicts the oldest idle principal once the map is full. */
function evictIfFull(principalId: string): void {
  if (states.size < MAX_ENTRIES || states.has(principalId)) {
    return;
  }
  for (const [key, state] of states) {
    if (state.active === 0) {
      states.delete(key);
      return;
    }
  }
}

async function fetchTrust(
  principalId: string,
): Promise<{ trust: VellumPrincipalTrust; cacheable: boolean }> {
  const result = await readInboundTrust({
    channelType: "vellum",
    actorExternalId: principalId,
  });

  if (!result.ok) {
    log.warn(
      { principalId },
      "vellum principal trust unresolved: gateway read failed",
    );
    return { trust: UNKNOWN, cacheable: false };
  }

  const { verdict } = result;

  if (verdict.resolutionFailed) {
    log.warn(
      { principalId },
      "vellum principal trust unresolved: gateway could not vouch",
    );
    return { trust: UNKNOWN, cacheable: false };
  }

  const trust: VellumPrincipalTrust = { trustClass: verdict.trustClass };
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
): Promise<VellumPrincipalTrust> {
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
    });

  if (!forceRefresh) {
    state.inFlight = promise;
  }
  return promise;
}

/**
 * Trust class for a `vellum` principal, from cache when fresh. Resolves
 * `unknown` for an unknown, revoked, or blocked principal, and for any read
 * the gateway could not complete.
 */
export function resolveVellumPrincipal(
  principalId: string,
): Promise<VellumPrincipalTrust> {
  return read(principalId, false);
}

/**
 * Uncached variant of {@link resolveVellumPrincipal}, for callers whose threat
 * model is the stale entry itself. Repopulates the cache on success.
 */
export function resolveVellumPrincipalFresh(
  principalId: string,
): Promise<VellumPrincipalTrust> {
  return read(principalId, true);
}

/** Test-only: reset cache + in-flight state for deterministic test runs. */
export function __resetVellumPrincipalCacheForTest(): void {
  states.clear();
}
