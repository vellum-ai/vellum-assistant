/**
 * Self-hosted capability-token bootstrap for the Vellum chrome extension.
 *
 * Directly POSTs to the gateway's `/v1/browser-extension-pair` endpoint
 * to exchange the calling extension's origin for a capability token.
 *
 * Previous versions used Chrome's native messaging API to spawn a helper
 * binary that proxied this HTTP call. This was fundamentally broken for
 * (a) non-macOS self-hosted users (no binary distribution) and
 * (b) non-Chrome Chromium browsers (manifest path is browser-specific).
 * The extension now calls the gateway directly via `fetch()`, which works
 * everywhere — Chrome extensions with `<all_urls>` host permission bypass
 * CORS for service-worker fetches.
 *
 * Storage is assistant-scoped: each gateway URL gets its own storage key
 * (`vellum.localCapabilityToken:<urlHash>`) so switching between gateways
 * never clobbers another gateway's credentials.
 */

export interface StoredLocalToken {
  token: string;
  expiresAt: number; // ms since epoch
  guardianId: string;
  /**
   * The gateway base URL this token was minted against. Stored alongside
   * the token so reconnect logic can target the correct relay endpoint.
   */
  gatewayUrl: string;
}

const STORAGE_KEY_PREFIX = 'vellum.localCapabilityToken';
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 5_000;

/**
 * Chrome.storage.local key for the user-configured self-hosted gateway URL.
 * Defaults to `http://127.0.0.1:7830` when absent.
 */
export const GATEWAY_URL_STORAGE_KEY = 'vellum.selfHostedGatewayUrl';
export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:7830';

/**
 * Window (ms) before `expiresAt` inside which we treat the stored local token
 * as "stale" and proactively re-bootstrap it. 60 seconds mirrors the cloud
 * token stale semantics.
 */
export const LOCAL_TOKEN_STALE_WINDOW_MS = 60_000;

/**
 * Return `true` when the stored local token is expired or within
 * {@link LOCAL_TOKEN_STALE_WINDOW_MS} of expiring.
 */
export function isLocalTokenStale(
  token: StoredLocalToken | null,
  now: number = Date.now(),
): boolean {
  if (!token) return true;
  return token.expiresAt - now <= LOCAL_TOKEN_STALE_WINDOW_MS;
}

/**
 * The legacy unscoped storage key used before gateway-URL-scoped keys
 * were introduced. Existing users may have a token stored under this
 * key from a previous version of the extension.
 */
export const LEGACY_LOCAL_STORAGE_KEY = 'vellum.localCapabilityToken';

/**
 * Build a storage key scoped to a gateway URL.
 */
export function localTokenStorageKey(gatewayUrl: string): string {
  return `${STORAGE_KEY_PREFIX}:${gatewayUrl}`;
}

export interface BootstrapDirectPairOptions {
  timeoutMs?: number;
}

/**
 * Validate and return a parsed {@link StoredLocalToken} from a raw storage
 * value, or `null` when the value is missing, malformed, or expired.
 */
export function validateLocalToken(raw: unknown): StoredLocalToken | null {
  if (!raw || typeof raw !== 'object') return null;
  const token = raw as StoredLocalToken;
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
 * Read the gateway-URL-scoped local capability token from chrome.storage.
 */
export async function getStoredLocalToken(
  gatewayUrl: string,
): Promise<StoredLocalToken | null> {
  const key = localTokenStorageKey(gatewayUrl);
  const result = await chrome.storage.local.get(key);
  return validateLocalToken(result[key]);
}

/**
 * Persist a local capability token scoped to a gateway URL.
 */
async function storeLocalToken(
  gatewayUrl: string,
  token: StoredLocalToken,
): Promise<void> {
  const key = localTokenStorageKey(gatewayUrl);
  await chrome.storage.local.set({ [key]: token });
}

/**
 * Read the user-configured self-hosted gateway URL from storage.
 * Returns {@link DEFAULT_GATEWAY_URL} when nothing is stored.
 */
export async function getStoredGatewayUrl(): Promise<string> {
  const result = await chrome.storage.local.get(GATEWAY_URL_STORAGE_KEY);
  const stored = result[GATEWAY_URL_STORAGE_KEY];
  return typeof stored === 'string' && stored.length > 0
    ? stored
    : DEFAULT_GATEWAY_URL;
}

/**
 * Persist the user-configured self-hosted gateway URL.
 */
export async function setStoredGatewayUrl(url: string): Promise<void> {
  await chrome.storage.local.set({ [GATEWAY_URL_STORAGE_KEY]: url });
}

/**
 * Bootstrap a self-hosted capability token by POSTing directly to the
 * gateway's `/v1/browser-extension-pair` endpoint.
 *
 * The gateway requires:
 *   - Localhost peer IP (satisfied by fetching 127.0.0.1)
 *   - `x-vellum-native-host: 1` marker header
 *   - `{ extensionOrigin }` body with the extension's origin
 *
 * Returns the stored token shape after persisting it.
 */
export async function bootstrapDirectPairToken(
  gatewayUrl: string,
  options: BootstrapDirectPairOptions = {},
): Promise<StoredLocalToken> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const baseUrl = gatewayUrl.replace(/\/+$/, '');
    const response = await fetch(`${baseUrl}/v1/browser-extension-pair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-vellum-native-host': '1',
      },
      body: JSON.stringify({ extensionOrigin }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = response.statusText;
      try {
        const body = await response.json() as { error?: { message?: string } };
        if (body?.error?.message) {
          detail = body.error.message;
        }
      } catch {
        // Response body wasn't JSON — use statusText.
      }
      throw new Error(
        `Gateway pair request failed (${response.status}): ${detail}`,
      );
    }

    const body = await response.json() as {
      token?: string;
      expiresAt?: string;
      guardianId?: string;
    };

    if (
      typeof body.token !== 'string' ||
      typeof body.expiresAt !== 'string' ||
      typeof body.guardianId !== 'string'
    ) {
      throw new Error('Invalid pair response: missing token, expiresAt, or guardianId');
    }

    const expiresAtMs = new Date(body.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error('Invalid pair response: expiresAt is in the past or unparseable');
    }

    const stored: StoredLocalToken = {
      token: body.token,
      expiresAt: expiresAtMs,
      guardianId: body.guardianId,
      gatewayUrl,
    };

    await storeLocalToken(gatewayUrl, stored);
    return stored;
  } finally {
    clearTimeout(timer);
  }
}
