import { fetchPlatformStatus, isUuid } from "@/lib/local-platform-identity";
import {
  getLockfileAssistant,
  getPairedGatewayUrl,
  updateLockfileAssistant,
} from "@/lib/local-mode";

/**
 * One resolved UUID per paired target per session. A miss (unreachable,
 * not yet registered) is evicted so the next ask probes again. Keyed by
 * gateway URL as well as id so a same-name re-pair to another gateway
 * probes again.
 */
const pairedPlatformIdCache = new Map<string, Promise<string | null>>();

function pairedCacheKey(assistantId: string): string {
  return `${assistantId}\n${getLockfileAssistant(assistantId)?.runtimeUrl ?? ""}`;
}

export function resetPairedPlatformIdentityCacheForTesting(): void {
  pairedPlatformIdCache.clear();
}

/**
 * The platform UUID a paired assistant is registered under, or null.
 *
 * `pairAssistant` keys the lockfile entry by a local slug and the pairing
 * reply carries no platform id, so the entry lacks `platformAssistantId`
 * until something asks the paired daemon. Its `platform/status` route
 * answers through the same-origin paired proxy (the host injects the
 * guardian bearer, the gateway's runtime-proxy catch-all discards the id in
 * the path), and the UUID is persisted to the entry so `setFromLockfile`
 * carries it from then on. Never throws.
 */
export function resolvePairedAssistantPlatformId(
  assistantId: string,
): Promise<string | null> {
  const key = pairedCacheKey(assistantId);
  const cached = pairedPlatformIdCache.get(key);
  if (cached) {
    return cached;
  }
  const promise = fetchAndPersistPairedPlatformId(assistantId).then((id) => {
    if (id === null) {
      pairedPlatformIdCache.delete(key);
    }
    return id;
  });
  pairedPlatformIdCache.set(key, promise);
  return promise;
}

async function fetchAndPersistPairedPlatformId(
  assistantId: string,
): Promise<string | null> {
  const entry = getLockfileAssistant(assistantId);
  if (!entry) {
    return null;
  }
  if (entry.platformAssistantId) {
    return entry.platformAssistantId;
  }
  const pairedUrl = getPairedGatewayUrl(entry);
  if (!pairedUrl) {
    return null;
  }
  const status = await fetchPlatformStatus(
    { gatewayUrl: `${window.location.origin}${pairedUrl}`, actorToken: null },
    assistantId,
  );
  const platformAssistantId = status?.assistantId ?? null;
  if (!platformAssistantId || !isUuid(platformAssistantId)) {
    return null;
  }
  // Re-read: a rename or re-pair may have landed while the request was in flight.
  const current = getLockfileAssistant(assistantId);
  if (
    !current ||
    current.cloud !== "paired" ||
    current.runtimeUrl !== entry.runtimeUrl
  ) {
    return null;
  }
  try {
    await updateLockfileAssistant({ ...current, platformAssistantId });
  } catch (error) {
    console.warn("paired assistant platform lockfile update failed", error);
  }
  return platformAssistantId;
}
