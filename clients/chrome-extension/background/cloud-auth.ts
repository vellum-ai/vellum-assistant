/**
 * Cloud OAuth sign-in state machine for the Vellum chrome extension.
 *
 * Launches chrome.identity.launchWebAuthFlow against the Vellum gateway and
 * persists the guardian-bound JWT in chrome.storage.local. The token is used
 * to authenticate the browser-relay WebSocket against the cloud gateway.
 *
 * Also exposes {@link refreshCloudToken}, the non-interactive refresh helper
 * used by the relay reconnect path when the stored token has expired or the
 * server closed the socket with an auth-failure code. Non-interactive means
 * it calls `launchWebAuthFlow({ interactive: false })` — Chrome will either
 * return a fresh token from an existing provider session or immediately
 * reject with "interaction required", in which case the caller must prompt
 * the user to sign in again instead of silently looping.
 */

export interface CloudAuthConfig {
  /** Gateway base URL, e.g. https://api.vellum.ai */
  gatewayBaseUrl: string;
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
 * WebSocket close codes the gateway uses to signal that the handshake was
 * rejected for an auth reason — an expired JWT, a revoked guardian, or a
 * rotated signing key. The relay reconnect path treats these specially and
 * forces a token refresh before the next connect attempt.
 *
 * - `4001`/`4002`/`4003` are in the RFC 6455 "application" range
 *   (4000–4999) and match the codes emitted by
 *   `gateway/src/http/routes/browser-relay-websocket.ts` for the three
 *   distinct auth-failure paths.
 * - `1008` ("policy violation") is included for robustness — some
 *   intermediaries rewrite application codes back to 1008 when the socket
 *   is torn down mid-handshake.
 */
export const CLOUD_AUTH_FAILURE_CLOSE_CODES: ReadonlySet<number> = new Set([
  1008, 4001, 4002, 4003,
]);

const STORAGE_KEY = 'vellum.cloudAuthToken';

export async function getStoredToken(): Promise<StoredCloudToken | null> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const raw = result[STORAGE_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const token = raw as StoredCloudToken;
  if (
    typeof token.token !== 'string' ||
    typeof token.expiresAt !== 'number' ||
    typeof token.guardianId !== 'string'
  ) {
    return null;
  }
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
export async function getStoredTokenRaw(): Promise<StoredCloudToken | null> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const raw = result[STORAGE_KEY];
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

export async function clearStoredToken(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

async function persistToken(token: StoredCloudToken): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: token });
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

function buildAuthUrl(config: CloudAuthConfig): string {
  const redirectUri = chrome.identity.getRedirectURL('cloud-auth');
  return (
    `${config.gatewayBaseUrl.replace(/\/$/, '')}/oauth/chrome-extension/start` +
    `?client_id=${encodeURIComponent(config.clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`
  );
}

/**
 * Launches chrome.identity.launchWebAuthFlow to obtain a guardian-bound JWT.
 * The extension receives the token via the redirect URI fragment.
 */
export async function signInCloud(config: CloudAuthConfig): Promise<StoredCloudToken> {
  const authUrl = buildAuthUrl(config);

  const responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  if (!responseUrl) throw new Error('cloud sign-in cancelled');

  const stored = parseAuthResponseUrl(responseUrl);
  await persistToken(stored);
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
  config: CloudAuthConfig,
): Promise<StoredCloudToken | null> {
  const authUrl = buildAuthUrl(config);

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
  await persistToken(stored);
  return stored;
}
