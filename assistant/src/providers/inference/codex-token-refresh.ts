/**
 * Automatic token refresh for ChatGPT Codex OAuth (subscription auth).
 *
 * OpenAI rotates refresh tokens on every use — concurrent refreshes will
 * invalidate one token. A module-level mutex prevents this race.
 */

import { refreshOAuth2Token } from "../../security/oauth2.js";
import {
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("codex-token-refresh");

const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Refresh 5 minutes before expiry to avoid using a nearly-expired token. */
const REFRESH_MARGIN_SECONDS = 300;

/**
 * Module-level mutex to prevent concurrent refresh races.
 * OpenAI rotates refresh tokens on every use — two concurrent refreshes
 * will invalidate one token.
 */
let refreshInFlight: Promise<string | null> | null = null;

/**
 * Return a valid Codex access token, refreshing transparently if expired.
 *
 * @param credentialPrefix - Credential key prefix, e.g. `"credential/chatgpt"`.
 *   The function reads `<prefix>/access_token`, `<prefix>/refresh_token`,
 *   and `<prefix>/expires_at` from the credential store.
 * @returns The access token string, or `null` if no token is stored.
 */
export async function getValidCodexAccessToken(
  credentialPrefix: string,
): Promise<string | null> {
  const accessToken = await getSecureKeyAsync(
    `${credentialPrefix}/access_token`,
  );
  if (!accessToken) return null;

  const expiresAtStr = await getSecureKeyAsync(
    `${credentialPrefix}/expires_at`,
  );
  if (!expiresAtStr) return accessToken; // no expiry info — use token as-is

  const expiresAt = Number(expiresAtStr);
  const now = Date.now() / 1000;

  if (now < expiresAt - REFRESH_MARGIN_SECONDS) {
    return accessToken; // token is still fresh
  }

  // Token is expired or about to expire — refresh it.
  // Use mutex to prevent concurrent refresh races.
  if (refreshInFlight) {
    return await refreshInFlight;
  }

  refreshInFlight = doRefresh(credentialPrefix);
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function doRefresh(credentialPrefix: string): Promise<string | null> {
  const refreshToken = await getSecureKeyAsync(
    `${credentialPrefix}/refresh_token`,
  );
  if (!refreshToken) {
    log.warn("No refresh token available for Codex OAuth");
    // Return the existing access token — it might still work even if expired
    return (
      (await getSecureKeyAsync(`${credentialPrefix}/access_token`)) ?? null
    );
  }

  try {
    const result = await refreshOAuth2Token(
      CODEX_TOKEN_URL,
      CODEX_CLIENT_ID,
      refreshToken,
    );

    // Store the new tokens
    await setSecureKeyAsync(
      `${credentialPrefix}/access_token`,
      result.accessToken,
    );
    if (result.refreshToken) {
      await setSecureKeyAsync(
        `${credentialPrefix}/refresh_token`,
        result.refreshToken,
      );
    }
    if (result.expiresIn) {
      const newExpiresAt = Math.floor(Date.now() / 1000 + result.expiresIn);
      await setSecureKeyAsync(
        `${credentialPrefix}/expires_at`,
        String(newExpiresAt),
      );
    }

    log.info("Codex OAuth token refreshed successfully");
    return result.accessToken;
  } catch (err) {
    log.error({ err }, "Codex OAuth token refresh failed");
    // Return the existing access token as fallback
    return (
      (await getSecureKeyAsync(`${credentialPrefix}/access_token`)) ?? null
    );
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** @internal Test-only: reset the in-flight refresh mutex. */
export function _resetRefreshMutex(): void {
  refreshInFlight = null;
}
