/**
 * Cloud OAuth sign-in state machine for the Vellum chrome extension.
 *
 * Launches chrome.identity.launchWebAuthFlow against the Vellum gateway and
 * persists the guardian-bound JWT in chrome.storage.local. The token is used
 * by later PRs to authenticate the browser-relay WebSocket against the cloud
 * gateway — this module is the storage + state machine layer only.
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

export async function clearStoredToken(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

async function persistToken(token: StoredCloudToken): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: token });
}

/**
 * Launches chrome.identity.launchWebAuthFlow to obtain a guardian-bound JWT.
 * The extension receives the token via the redirect URI fragment.
 */
export async function signInCloud(config: CloudAuthConfig): Promise<StoredCloudToken> {
  const redirectUri = chrome.identity.getRedirectURL('cloud-auth');
  const authUrl =
    `${config.gatewayBaseUrl.replace(/\/$/, '')}/oauth/chrome-extension/start` +
    `?client_id=${encodeURIComponent(config.clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  const responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  if (!responseUrl) throw new Error('cloud sign-in cancelled');

  const hash = new URL(responseUrl).hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);
  const token = params.get('token');
  const expiresIn = parseInt(params.get('expires_in') ?? '0', 10);
  const guardianId = params.get('guardian_id') ?? '';
  if (!token || !expiresIn || !guardianId) {
    throw new Error('cloud sign-in returned incomplete payload');
  }
  const stored: StoredCloudToken = {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
    guardianId,
  };
  await persistToken(stored);
  return stored;
}
