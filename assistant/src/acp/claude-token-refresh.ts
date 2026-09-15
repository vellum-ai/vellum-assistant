/**
 * Renewal policy for the Claude OAuth credential the ACP spawn path injects as
 * `CLAUDE_CODE_OAUTH_TOKEN`. Storage lives in `acp-claude-oauth.ts`; this
 * module owns only the decision to refresh and the handling of what comes back.
 *
 * Setting `CLAUDE_CODE_OAUTH_TOKEN` tells the Claude Agent SDK to treat the
 * value as a static bearer token: its own credential store and refresh
 * machinery are skipped entirely. The SDK does expose a host-refresh hook,
 * `getOAuthToken`, but `claude-agent-acp` never passes it through and it is
 * absent from the SDK's public typings. With the env-var contract the adapter
 * gives us, the daemon is the only thing that can renew this token.
 *
 * Every failure mode here returns without throwing and lets the spawn proceed
 * with whatever token is stored. A dead token then fails at the adapter as a
 * structured ACP `auth_required`, which raises the Connect card. Renewal is
 * the fast path, not the error path, so it must never be the thing that fails
 * a spawn.
 *
 * When the provider rejects the refresh token itself (revoked, or rotated out
 * from under us), the stored refresh token is dropped. The recorded expiry is
 * kept, because that pair (expired, no way to renew) is what makes
 * `hasAcpClaudeToken()` answer "not connected" and keep the inline Connect
 * card on screen.
 */

import {
  isCredentialError,
  RefreshDeduplicator,
} from "@vellumai/credential-storage";

import { refreshOAuth2Token } from "../security/oauth2.js";
import { getLogger } from "../util/logger.js";
import {
  CLAUDE_OAUTH_CONFIG,
  clearAcpClaudeRefreshToken,
  forgetAcpClaudeRenewalStateIfUnbound,
  hasStoredAcpClaudeAccessToken,
  isAcpClaudeTokenExpiring,
  persistRefreshedAcpClaudeTokens,
  readAcpClaudeRefreshToken,
} from "./acp-claude-oauth.js";
import { ACP_OAUTH_TOKEN_FIELD } from "./acp-credentials.js";
import { acpSpawnCredentialDenialReason } from "./prepare-agent-env.js";

const log = getLogger("acp:claude-token-refresh");

/**
 * Single in-flight refresh across concurrent spawns. Anthropic rotates the
 * refresh token on use, so two parallel refreshes would race and one would
 * invalidate the other's token.
 */
const deduplicator = new RefreshDeduplicator();
const REFRESH_KEY = "acp:claude";

/**
 * Renew the stored Claude access token if it is expiring and a refresh token
 * is available. Returns without throwing in every failure mode. Never returns
 * the token: the plaintext read boundary stays with the credential broker, so
 * callers re-read through it as usual.
 */
export async function ensureFreshAcpClaudeToken(): Promise<void> {
  // An explicit `allowedTools` that omits `acp_spawn` means the broker will
  // deny the read this renewal exists to feed, so there is nothing to gain by
  // spending a refresh token here. Checking first also keeps a passive spawn
  // from touching a credential the workspace has fenced off.
  if (acpSpawnCredentialDenialReason(ACP_OAUTH_TOKEN_FIELD) !== undefined) {
    return;
  }
  // Companions can outlive a deleted access token. Renewal exists to replace
  // that field, not to mint a new credential after the user removed it.
  if (!(await hasStoredAcpClaudeAccessToken())) {
    return;
  }
  try {
    await forgetAcpClaudeRenewalStateIfUnbound();
  } catch (err) {
    log.debug(
      { err },
      "Could not drop unbound Claude OAuth renewal state before refresh",
    );
  }
  if (!(await isAcpClaudeTokenExpiring())) {
    return;
  }

  const refreshToken = await readAcpClaudeRefreshToken();
  if (!refreshToken) {
    log.info(
      "Claude OAuth token is expiring and no refresh token is stored; " +
        "the spawn will surface auth_required so the user can reconnect",
    );
    return;
  }

  try {
    await deduplicator.deduplicate(REFRESH_KEY, () => doRefresh(refreshToken));
  } catch (err) {
    log.debug({ err }, "Claude OAuth token refresh did not complete");
  }
}

async function doRefresh(refreshToken: string): Promise<string> {
  log.info("Refreshing the Claude OAuth token for ACP");

  let result;
  try {
    result = await refreshOAuth2Token(
      CLAUDE_OAUTH_CONFIG.tokenExchangeUrl,
      CLAUDE_OAUTH_CONFIG.clientId,
      refreshToken,
      // PKCE public client, so no secret. Anthropic's token endpoint takes a
      // JSON body, matching the authorization-code exchange.
      undefined,
      undefined,
      CLAUDE_OAUTH_CONFIG.tokenExchangeBodyFormat,
    );
  } catch (err) {
    if (isCredentialError(err)) {
      log.warn(
        { err },
        "Claude OAuth refresh token was rejected; dropping it so the account reads as needing a reconnect",
      );
      await clearAcpClaudeRefreshToken(refreshToken);
    } else {
      log.warn({ err }, "Claude OAuth token refresh failed transiently");
    }
    throw err;
  }

  if (!result.accessToken) {
    log.warn(
      "Claude OAuth refresh returned no usable access token; dropping the refresh token so the account reads as needing a reconnect",
    );
    await clearAcpClaudeRefreshToken(refreshToken);
    throw new Error("Claude OAuth refresh returned no access token");
  }

  const persisted = await persistRefreshedAcpClaudeTokens(
    {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
    },
    refreshToken,
  );
  if (persisted) {
    log.info("Claude OAuth token refreshed");
  }
  return result.accessToken;
}
