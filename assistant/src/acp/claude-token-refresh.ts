/**
 * Renewal policy for the Claude OAuth credential the ACP spawn path injects as
 * `CLAUDE_CODE_OAUTH_TOKEN`. Storage lives in `acp-claude-oauth.ts`; this
 * module owns only the decision to refresh and the handling of what comes back.
 *
 * WHY THE DAEMON REFRESHES THIS AT ALL
 *
 * Setting `CLAUDE_CODE_OAUTH_TOKEN` tells the Claude Agent SDK to treat the
 * value as a static bearer token: its own credential store and refresh
 * machinery are skipped entirely (the SDK's credentials-file/keychain lookup is
 * guarded on that variable being unset). The SDK does expose a host-refresh
 * hook, `getOAuthToken`, but it is unreachable from here: `claude-agent-acp`
 * never passes it through, and it is absent from the SDK's public typings. So
 * with the env-var contract the adapter gives us, the daemon is the only thing
 * that CAN renew this token. Nothing downstream will do it for us.
 *
 * The renewal itself is ordinary OAuth2. The Connect Claude flow authorizes
 * against Claude Code's own public OAuth client, which issues refresh tokens,
 * and `refreshOAuth2Token` already implements the `refresh_token` grant with
 * retry and credential-error classification.
 *
 * WHAT HAPPENS WHEN RENEWAL IS NOT POSSIBLE
 *
 * Every failure mode here is deliberately quiet: this returns without throwing
 * and lets the spawn proceed with whatever token is stored. A dead token then
 * fails at the adapter as a structured ACP `auth_required`, which is the signal
 * the re-authentication UI is built on. Renewal is the fast path, not the error
 * path, so it must never be the thing that fails a spawn.
 *
 * One case is not quiet: when the provider rejects the refresh token itself
 * (revoked, or rotated out from under us), the stored refresh material is
 * cleared. That flips `hasAcpClaudeToken()` to "not connected", which is what
 * keeps the inline Connect card on screen instead of letting it self-dismiss
 * against a credential that can never be renewed.
 */

import {
  isCredentialError,
  RefreshDeduplicator,
} from "@vellumai/credential-storage";

import { refreshOAuth2Token } from "../security/oauth2.js";
import { getLogger } from "../util/logger.js";
import {
  CLAUDE_OAUTH_CONFIG,
  clearAcpClaudeRefreshMaterial,
  isAcpClaudeTokenExpiring,
  readAcpClaudeRefreshToken,
  storeAcpClaudeTokens,
} from "./acp-claude-oauth.js";

const log = getLogger("acp:claude-token-refresh");

/**
 * Single in-flight refresh across concurrent spawns. Anthropic rotates the
 * refresh token on use, so two parallel refreshes would race and one would
 * invalidate the other's token.
 */
const deduplicator = new RefreshDeduplicator();
const REFRESH_KEY = "acp:claude";

/**
 * Renew the stored Claude access token if it is expiring and a refresh token is
 * available. Returns without throwing in every failure mode; see the module
 * comment for why. Never returns the token: the plaintext read boundary stays
 * with the credential broker, so callers re-read through it as usual.
 */
export async function ensureFreshAcpClaudeToken(): Promise<void> {
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
    // Already classified and logged in doRefresh. Swallowed so a refresh
    // outage cannot fail a spawn that might still succeed on the stored token.
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
      // The refresh token is revoked or rotated out from under us. Clear it so
      // the connected check reports "not connected" and the user is offered a
      // reconnect, rather than re-attempting a grant that cannot succeed.
      log.warn(
        { err },
        "Claude OAuth refresh token was rejected; clearing stored refresh material",
      );
      await clearAcpClaudeRefreshMaterial();
    } else {
      log.warn({ err }, "Claude OAuth token refresh failed transiently");
    }
    throw err;
  }

  await storeAcpClaudeTokens({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresIn: result.expiresIn,
  });
  log.info("Claude OAuth token refreshed");
  return result.accessToken;
}
