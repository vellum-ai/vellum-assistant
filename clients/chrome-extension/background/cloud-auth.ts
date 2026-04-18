/**
 * Cloud OAuth sign-in state machine for the Vellum chrome extension.
 *
 * Launches chrome.identity.launchWebAuthFlow against the Vellum web app
 * and persists the guardian-bound JWT in chrome.storage.local. The token
 * is used to authenticate the browser-relay WebSocket against the cloud
 * gateway.
 *
 * The `CloudAuthConfig.webBaseUrl` field points to the Next.js web app
 * that serves the browser-facing OAuth start page
 * (`/accounts/chrome-extension/start`). Always `https://www.vellum.ai` in
 * production. The gateway / relay URL is managed separately by the
 * caller (worker.ts) and is not part of the auth config.
 *
 * Also exposes {@link refreshCloudToken}, the non-interactive refresh helper
 * used by the relay reconnect path when the stored token has expired or the
 * server closed the socket with an auth-failure code. Non-interactive means
 * it calls `launchWebAuthFlow({ interactive: false })` — Chrome will either
 * return a fresh token from an existing provider session or immediately
 * reject with "interaction required", in which case the caller must prompt
 * the user to sign in again instead of silently looping.
 *
 * Storage is assistant-scoped: each assistant ID gets its own storage key
 * (`vellum.cloudAuthToken:<assistantId>`) so switching between assistants
 * never clobbers another assistant's credentials.
 */

export interface CloudAuthConfig {
  /** Web app base URL for browser-facing pages, e.g. https://www.vellum.ai */
  webBaseUrl: string;
  /** OAuth client id registered for the chrome extension. */
  clientId: string;
}

export interface StoredCloudToken {
  token: string;
  expiresAt: number; // ms since epoch
  guardianId: string;
}

/**
 * Window (ms) before `expiresAt` inside which we treat the stored token as
 * "stale" and proactively refresh it. 60 seconds gives us enough headroom
 * that an in-flight reconnect doesn't race the gateway's own expiry check.
 */
export const CLOUD_TOKEN_STALE_WINDOW_MS = 60_000;

/**
 * WebSocket close codes that the relay reconnect path treats as a
 * strong signal the server rejected the handshake for an auth reason —
 * an expired JWT, a revoked guardian, or a rotated signing key. When
 * any of these fire, the cloudReconnectHook forces a token refresh
 * before the next connect attempt.
 *
 * IMPORTANT: the set deliberately does NOT include `1006` because 1006
 * ("abnormal closure") also fires on transient network blips and can't
 * be disambiguated from an auth failure by code alone. The gateway
 * (see `gateway/src/http/routes/browser-relay-websocket.ts`) and the
 * runtime reject invalid actor tokens with an HTTP 401 BEFORE the
 * WebSocket upgrade, which browsers surface as close code 1006 (never
 * 4001/4002/4003). The cloudReconnectHook in worker.ts applies an
 * attempt-counter heuristic to handle that case separately: it forces
 * a refresh on the first 1006 after connect, and aborts with a
 * sign-in prompt after a small number of failed refreshes. See that
 * hook's `REFRESH_ATTEMPT_CAP` for details.
 *
 * Codes that ARE in this set:
 * - `1008` ("policy violation") — observed in practice when the
 *   gateway or its upstream runtime rejects a frame after a successful
 *   handshake (e.g. buffer overflow, explicit policy kicks). The
 *   runtime may also bubble up 1008 when the actor-token binding
 *   becomes stale mid-session.
 * - `4001`/`4002`/`4003` are in the RFC 6455 "application" range
 *   (4000–4999). Neither the gateway nor the runtime emits these
 *   today for the standard pre-upgrade auth rejection (that path is
 *   HTTP 401 → 1006), but they are retained as a forward-compatible
 *   contract: future gateway changes may close the socket with a
 *   4xxx code for post-upgrade auth failures (e.g. a rotated signing
 *   key invalidating an already-connected socket) without requiring
 *   a matching extension update.
 */
export const CLOUD_AUTH_FAILURE_CLOSE_CODES: ReadonlySet<number> = new Set([
  1008, 4001, 4002, 4003,
]);

const STORAGE_KEY_PREFIX = 'vellum.cloudAuthToken';

/**
 * The legacy unscoped storage key used before assistant-scoped keys were
 * introduced. Existing users may have a token stored under this key from
 * a previous version of the extension. The migration helpers below
 * transparently promote it to the new scoped key on first read.
 *
 * Exported so the worker can fall back to reading this key when no
 * assistant is selected yet (backward-compatible connect flow).
 */
export const LEGACY_CLOUD_STORAGE_KEY = 'vellum.cloudAuthToken';

/**
 * Build the assistant-scoped chrome.storage.local key for a cloud auth
 * token. Uses a colon separator so the key is
 * `vellum.cloudAuthToken:<assistantId>`.
 */
export function cloudTokenStorageKey(assistantId: string): string {
  return `${STORAGE_KEY_PREFIX}:${assistantId}`;
}

/**
 * Check for a token stored under the legacy unscoped key
 * (`vellum.cloudAuthToken`). If found and valid, migrate it to the new
 * assistant-scoped key and remove the legacy key. The migration is
 * idempotent — once the legacy key is removed, subsequent calls are a
 * no-op.
 *
 * Returns the migrated token (without expiry check) or `null`.
 */
async function migrateLegacyCloudToken(assistantId: string): Promise<StoredCloudToken | null> {
  const scopedKey = cloudTokenStorageKey(assistantId);

  // Only migrate when the scoped key is still empty — avoids clobbering
  // a token that was stored directly under the scoped key after sign-in.
  const scopedResult = await chrome.storage.local.get(scopedKey);
  if (scopedResult[scopedKey] !== undefined) return null;

  const legacyResult = await chrome.storage.local.get(LEGACY_CLOUD_STORAGE_KEY);
  const legacyToken = validateCloudToken(legacyResult[LEGACY_CLOUD_STORAGE_KEY]);
  if (!legacyToken) return null;

  // Write to the new scoped key and remove the legacy key atomically
  // (as atomic as chrome.storage.local allows — both ops are awaited).
  await chrome.storage.local.set({ [scopedKey]: legacyToken });
  await chrome.storage.local.remove(LEGACY_CLOUD_STORAGE_KEY);

  return legacyToken;
}

/**
 * Validate and return a parsed {@link StoredCloudToken} from a raw storage
 * value, or `null` when the value is missing, malformed, or does not pass
 * type checks. Does NOT check expiry — callers that need expiry filtering
 * should check separately.
 */
export function validateCloudToken(raw: unknown): StoredCloudToken | null {
  if (!raw || typeof raw !== 'object') return null;
  const token = raw as StoredCloudToken;
  if (
    typeof token.token !== 'string' ||
    typeof token.expiresAt !== 'number' ||
    typeof token.guardianId !== 'string'
  ) {
    return null;
  }
  return token;
}

export async function getStoredToken(assistantId: string): Promise<StoredCloudToken | null> {
  const key = cloudTokenStorageKey(assistantId);
  const result = await chrome.storage.local.get(key);
  let token = validateCloudToken(result[key]);

  // Fallback: migrate a legacy unscoped token if no scoped token exists.
  if (!token) {
    token = await migrateLegacyCloudToken(assistantId);
  }

  if (!token) return null;
  if (token.expiresAt <= Date.now()) return null;
  return token;
}

/**
 * Return the raw stored cloud token without the "is this currently valid"
 * check in {@link getStoredToken}. This is used by the reconnect helper so
 * an expired token can still surface its `expiresAt` / `guardianId` for the
 * refresh decision — a `null` return from `getStoredToken()` would
 * indiscriminately conflate "never signed in" with "signed in but expired".
 */
export async function getStoredTokenRaw(assistantId: string): Promise<StoredCloudToken | null> {
  const key = cloudTokenStorageKey(assistantId);
  const result = await chrome.storage.local.get(key);
  const token = validateCloudToken(result[key]);
  if (token) return token;

  // Fallback: migrate a legacy unscoped token if no scoped token exists.
  return migrateLegacyCloudToken(assistantId);
}

/**
 * Return `true` when the stored token is expired or within
 * {@link CLOUD_TOKEN_STALE_WINDOW_MS} of expiring. `null`/missing tokens
 * also count as stale so callers can treat them uniformly.
 */
export function isCloudTokenStale(
  token: StoredCloudToken | null,
  now: number = Date.now(),
): boolean {
  if (!token) return true;
  return token.expiresAt - now <= CLOUD_TOKEN_STALE_WINDOW_MS;
}

export async function clearStoredToken(assistantId: string): Promise<void> {
  await chrome.storage.local.remove(cloudTokenStorageKey(assistantId));
}

async function persistToken(assistantId: string, token: StoredCloudToken): Promise<void> {
  await chrome.storage.local.set({ [cloudTokenStorageKey(assistantId)]: token });
}

function parseAuthResponseUrl(responseUrl: string): StoredCloudToken {
  const hash = new URL(responseUrl).hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);
  const token = params.get('token');
  const expiresIn = parseInt(params.get('expires_in') ?? '0', 10);
  const guardianId = params.get('guardian_id') ?? '';
  if (!token || !expiresIn || !guardianId) {
    throw new Error('cloud sign-in returned incomplete payload');
  }
  return {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
    guardianId,
  };
}

function buildAuthUrl(config: CloudAuthConfig, assistantId: string): string {
  const redirectUri = chrome.identity.getRedirectURL('cloud-auth');
  return (
    `${config.webBaseUrl.replace(/\/$/, '')}/accounts/chrome-extension/start` +
    `?client_id=${encodeURIComponent(config.clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&assistant_id=${encodeURIComponent(assistantId)}`
  );
}

/**
 * Launches chrome.identity.launchWebAuthFlow to obtain a guardian-bound JWT.
 * The extension receives the token via the redirect URI fragment.
 */
export async function signInCloud(assistantId: string, config: CloudAuthConfig): Promise<StoredCloudToken> {
  const authUrl = buildAuthUrl(config, assistantId);

  const responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  if (!responseUrl) throw new Error('cloud sign-in cancelled');

  const stored = parseAuthResponseUrl(responseUrl);
  await persistToken(assistantId, stored);
  return stored;
}

/**
 * Attempt a non-interactive renewal of the stored cloud token.
 *
 * Calls `chrome.identity.launchWebAuthFlow` with `interactive: false` so
 * Chrome will return a fresh token if the user still has a live provider
 * session, and will reject immediately with an "interaction required"
 * style error otherwise. This is the happy path used by the relay
 * reconnect hook — the caller falls back to surfacing a sign-in prompt in
 * the popup when this returns `null`.
 *
 * Returns the freshly persisted token on success, or `null` when Chrome
 * reports that interactive sign-in is required (or any other non-fatal
 * refresh failure). Throws for truly unexpected errors (e.g. malformed
 * gateway response) so they bubble up to the service worker logs.
 */
export async function refreshCloudToken(
  assistantId: string,
  config: CloudAuthConfig,
): Promise<StoredCloudToken | null> {
  const authUrl = buildAuthUrl(config, assistantId);

  let responseUrl: string | undefined;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: false,
    });
  } catch (err) {
    // Chrome rejects non-interactive flows with messages like
    // "OAuth2 not granted or revoked", "user interaction required",
    // or "The user did not approve access". Normalise all of these
    // to a null return so the caller falls back to prompting the
    // user to sign in again. Unexpected shapes still log through.
    console.warn(
      '[vellum-cloud-auth] non-interactive refresh rejected:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  if (!responseUrl) {
    // Some Chrome builds resolve with undefined instead of throwing when
    // interaction is required. Treat it the same way.
    console.warn('[vellum-cloud-auth] non-interactive refresh returned no URL');
    return null;
  }

  const stored = parseAuthResponseUrl(responseUrl);
  await persistToken(assistantId, stored);
  return stored;
}
