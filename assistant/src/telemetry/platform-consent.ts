/**
 * Platform consent cache for product-improvement trace collection.
 *
 * The user's `share_product_improvement` consent is authoritative on the
 * Vellum platform (the `UserConsent` record). The daemon has no settings-sync
 * channel that mirrors server consent into local config today, so it resolves
 * the consent directly from the platform via {@link VellumPlatformClient} and
 * caches it with a TTL.
 *
 * The recording decision ({@link recordTraceEvent}) runs synchronously on the
 * hot `agent_loop_exit` path and must not block on the network, so this module
 * splits the concern:
 *
 *  - {@link productImprovementConsentFromServer} — a **synchronous** read of
 *    the cached value. Fails closed: returns `false` until a fetch has
 *    affirmatively confirmed consent, and reverts to `false` whenever the
 *    cached value goes stale (so a long-offline daemon stops trusting an old
 *    affirmative).
 *  - {@link refreshPlatformConsent} — an async, single-flight, TTL-gated fetch
 *    that warms the cache. Callers fire it (fire-and-forget) on the edge of the
 *    turn path; any failure leaves the cache fail-closed.
 *
 * Endpoint: `GET /v1/assistants/{assistantId}/consent/` — an assistant-API-key
 * authenticated read that returns the owning user's consent flags (the daemon's
 * `Api-Key` credential cannot reach the session-authenticated
 * `/v1/user/consent/` endpoint). It resolves the owner from the key's assistant
 * (`assistant.created_by`), mirroring how telemetry ingest derives the owner.
 * Until that platform endpoint ships, the fetch fails closed and traces stay
 * dark — see PR notes.
 */

import { VellumPlatformClient } from "../platform/client.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("platform-consent");

/** How long a fetched consent value is trusted before it must be refreshed. */
const CONSENT_TTL_MS = 5 * 60 * 1000;
/**
 * How long a fetch failure suppresses re-fetching, so a persistently
 * unreachable / not-yet-deployed endpoint does not spin the network every turn.
 * Shorter than the success TTL so consent still propagates reasonably quickly
 * once the endpoint is reachable.
 */
const CONSENT_ERROR_BACKOFF_MS = 60 * 1000;

interface ConsentCache {
  /** Last successfully fetched value, or null if never fetched successfully. */
  value: boolean | null;
  /** Epoch ms of the last successful fetch. */
  fetchedAt: number;
  /** Epoch ms of the last fetch attempt (success or failure). */
  attemptedAt: number;
}

const cache: ConsentCache = { value: null, fetchedAt: 0, attemptedAt: 0 };
let inFlight: Promise<void> | null = null;

/**
 * Synchronous, fail-closed read of the cached `share_product_improvement`
 * consent. Returns `true` only when a fetch has affirmatively confirmed consent
 * AND that value is still within the TTL. Unknown, denied, or stale ⇒ `false`.
 */
export function productImprovementConsentFromServer(): boolean {
  if (cache.value !== true) return false;
  if (Date.now() - cache.fetchedAt > CONSENT_TTL_MS) return false;
  return true;
}

/** Whether a refresh is due (TTL expired for success, backoff for failure). */
function refreshDue(now: number): boolean {
  // Never attempted → due.
  if (cache.attemptedAt === 0) return true;
  // Last attempt failed (attemptedAt advanced past fetchedAt) → use backoff.
  if (cache.attemptedAt > cache.fetchedAt) {
    return now - cache.attemptedAt > CONSENT_ERROR_BACKOFF_MS;
  }
  // Last attempt succeeded → use the success TTL.
  return now - cache.fetchedAt > CONSENT_TTL_MS;
}

/**
 * Fetch `share_product_improvement` from the platform and update the cache.
 * Single-flight and TTL/backoff-gated, so calling it on every turn is cheap.
 * Fail-closed: any error (no client, non-2xx, parse failure, missing field)
 * records a failed attempt and leaves the synchronous read returning `false`.
 */
export async function refreshPlatformConsent(): Promise<void> {
  const now = Date.now();
  if (!refreshDue(now)) return;
  if (inFlight) return inFlight;
  inFlight = doRefresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doRefresh(): Promise<void> {
  cache.attemptedAt = Date.now();
  try {
    const client = await VellumPlatformClient.create();
    if (!client) {
      // Not logged in / platform features disabled — fail closed.
      return;
    }
    const path = `/v1/assistants/${client.platformAssistantId}/consent/`;
    const response = await client.fetch(path);
    if (!response.ok) {
      log.debug(
        { status: response.status },
        "Platform consent fetch returned non-2xx — failing closed",
      );
      return;
    }
    const body = (await response.json()) as Record<string, unknown>;
    const value = body.share_product_improvement;
    if (typeof value !== "boolean") {
      log.debug(
        "Platform consent response missing boolean share_product_improvement — failing closed",
      );
      return;
    }
    cache.value = value;
    cache.fetchedAt = Date.now();
  } catch (err) {
    log.debug({ err }, "Platform consent fetch failed — failing closed");
  }
}

/** Reset the cache. Test-only. */
export function _resetPlatformConsentCacheForTests(): void {
  cache.value = null;
  cache.fetchedAt = 0;
  cache.attemptedAt = 0;
  inFlight = null;
}

/**
 * Directly set the cached consent value as if a fresh fetch had just returned
 * it. Lets consumers exercise the synchronous gate without a network round
 * trip. Test-only.
 */
export function _setServerConsentForTests(value: boolean | null): void {
  cache.value = value;
  cache.fetchedAt = value === null ? 0 : Date.now();
  cache.attemptedAt = cache.fetchedAt;
}
