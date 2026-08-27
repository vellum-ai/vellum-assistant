import { fetchPlatformStatus } from "@/lib/local-platform-identity";
import {
  getLockfileAssistant,
  getPairedGatewayUrl,
  updateLockfileAssistant,
} from "@/lib/local-mode";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One attempt per paired id per session; a miss (unreachable, unregistered) is cached too. */
const pairedPlatformIdCache = new Map<string, Promise<string | null>>();

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
  const cached = pairedPlatformIdCache.get(assistantId);
  if (cached) {
    return cached;
  }
  const promise = fetchAndPersistPairedPlatformId(assistantId);
  pairedPlatformIdCache.set(assistantId, promise);
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
  if (!platformAssistantId || !UUID_RE.test(platformAssistantId)) {
    return null;
  }
  try {
    await updateLockfileAssistant({ ...entry, platformAssistantId });
  } catch (error) {
    console.warn("paired assistant platform lockfile update failed", error);
  }
  return platformAssistantId;
}
