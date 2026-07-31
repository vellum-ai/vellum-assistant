/**
 * In-memory member-verdict ACL cache for the voice call path.
 *
 * Warmed at the verdict-fetch choke point ({@link readInboundTrust} in
 * `calls/inbound-trust-reader.ts`) so the call-setup verdict read leaves the
 * resolved member ACL view behind for synchronous readers later in the same
 * call — today the access-request callback handoff
 * (`calls/access-request-wait.ts`), which resolves the requester's member
 * reference at wait teardown without awaiting a fresh gateway read. A true
 * miss is fail-closed by the caller.
 *
 * Keyed by `(channelType, canonicalized actorExternalId)`. A memberless verdict
 * (no resolvable {@link VerdictMember}) clears any cached entry for the actor —
 * it means "not a member", which the reader then treats as a miss.
 */

import type { TrustVerdict } from "@vellumai/gateway-client";

import type { ChannelId } from "../channels/types.js";
import type { ChannelPolicy, ChannelStatus } from "../contacts/types.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";
import { verdictMemberFromVerdict } from "./trust-verdict-consumer.js";

/** Member ACL view derived from a gateway verdict. */
export interface CachedMemberAcl {
  status: ChannelStatus;
  policy: ChannelPolicy;
}

// A verdict reflects revoke/block within a fetch cycle, so a minutes-scale TTL
// is safe; it mirrors the guardian-delivery cache's backstop expiry.
const MEMBER_VERDICT_TTL_MS = 300_000;

// Bounded to keep the map from growing without limit on high-fanout channels.
const MEMBER_VERDICT_MAX_ENTRIES = 2000;

interface CacheEntry {
  acl: CachedMemberAcl;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(channelType: ChannelId, canonicalActorId: string): string {
  return `${channelType}\u0000${canonicalActorId}`;
}

function canonicalize(
  channelType: ChannelId,
  actorExternalId: string | undefined,
): string | null {
  const trimmed = actorExternalId?.trim();
  if (!trimmed) {
    return null;
  }
  return canonicalizeInboundIdentity(channelType, trimmed);
}

/** Drop expired entries; when still over capacity, evict oldest-expiring first. */
function evictIfNeeded(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
  if (cache.size < MEMBER_VERDICT_MAX_ENTRIES) {
    return;
  }
  const ordered = [...cache.entries()].sort(
    (a, b) => a[1].expiresAt - b[1].expiresAt,
  );
  const overflow = cache.size - MEMBER_VERDICT_MAX_ENTRIES + 1;
  for (let i = 0; i < overflow && i < ordered.length; i++) {
    cache.delete(ordered[i][0]);
  }
}

/**
 * Cache the member ACL view derived from a gateway verdict. A memberless
 * verdict clears any existing entry for the actor (authoritative "not a
 * member"), so the reader can't serve a stale active ACL after the actor is
 * deleted or becomes a stranger. No-ops when the actor id is empty.
 */
export function setMemberVerdict(
  channelType: ChannelId,
  actorExternalId: string | undefined,
  verdict: TrustVerdict,
): void {
  const canonicalActorId = canonicalize(channelType, actorExternalId);
  if (!canonicalActorId) {
    return;
  }
  const key = cacheKey(channelType, canonicalActorId);

  const member = verdictMemberFromVerdict(verdict);
  if (!member) {
    // Authoritative "not a member" — drop any stale entry so a deleted/stranger
    // actor isn't served a now-invalid active ACL for the rest of the TTL.
    cache.delete(key);
    return;
  }

  const now = Date.now();
  evictIfNeeded(now);
  cache.set(key, {
    acl: { status: member.status, policy: member.policy },
    expiresAt: now + MEMBER_VERDICT_TTL_MS,
  });
}

/**
 * Read the cached member ACL view, or `undefined` when absent/expired. Callers
 * pass the raw actor id; canonicalization matches the writer.
 */
export function getCachedMemberAcl(
  channelType: ChannelId,
  actorExternalId: string | undefined,
): CachedMemberAcl | undefined {
  const canonicalActorId = canonicalize(channelType, actorExternalId);
  if (!canonicalActorId) {
    return undefined;
  }

  const entry = cache.get(cacheKey(channelType, canonicalActorId));
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    cache.delete(cacheKey(channelType, canonicalActorId));
    return undefined;
  }
  return entry.acl;
}

/** Test-only: clear cached entries for deterministic test runs. */
export function __resetMemberVerdictCacheForTest(): void {
  cache.clear();
}
