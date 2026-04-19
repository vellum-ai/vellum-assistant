/**
 * Runs an OAuth2 loopback flow to install the user's Slack app and capture
 * bot + user tokens in a single exchange.
 *
 * Prerequisites: client_id, client_secret, and app_token must already be
 * stored in the credential vault (service: slack_channel).
 *
 * The handler reads client credentials from secure storage, starts a
 * loopback OAuth server on port 17322, opens the browser to Slack's
 * authorize URL, and waits for the user to click "Allow". Slack's
 * oauth.v2.access response contains both the bot token (access_token)
 * and user token (authed_user.access_token). Both are stored via
 * setSlackChannelConfig.
 */

import { credentialKey } from "../../security/credential-key.js";
import { startOAuth2Flow } from "../../security/oauth2.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { openInHostBrowser } from "../../util/browser.js";
import { getLogger } from "../../util/logger.js";
import { setSlackChannelConfig } from "./config-slack-channel.js";

const log = getLogger("slack-channel-oauth-install");

/** Port pre-registered for Slack in seed-providers.ts. */
const SLACK_LOOPBACK_PORT = 17322;

/** Bot scopes matching the manifest in SKILL.md. */
const BOT_SCOPES = [
  "app_mentions:read",
  "assistant:write",
  "channels:history",
  "channels:join",
  "channels:read",
  "chat:write",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "users:read",
];

/** User scopes matching the manifest in SKILL.md. */
const USER_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "users:read",
  "search:read",
  "reactions:read",
];

export interface SlackOAuthInstallResult {
  success: boolean;
  hasBotToken: boolean;
  hasUserToken: boolean;
  error?: string;
}

export async function runSlackChannelOAuthInstall(): Promise<SlackOAuthInstallResult> {
  // Read client credentials from secure storage
  const clientId = await getSecureKeyAsync(
    credentialKey("slack_channel", "client_id"),
  );
  if (!clientId) {
    return {
      success: false,
      hasBotToken: false,
      hasUserToken: false,
      error:
        "Client ID not found in credential store. Store it first via credential_store prompt (service: slack_channel, field: client_id).",
    };
  }

  const clientSecret = await getSecureKeyAsync(
    credentialKey("slack_channel", "client_secret"),
  );
  if (!clientSecret) {
    return {
      success: false,
      hasBotToken: false,
      hasUserToken: false,
      error:
        "Client Secret not found in credential store. Store it first via credential_store prompt (service: slack_channel, field: client_secret).",
    };
  }

  log.info("Starting Slack OAuth install flow via loopback");

  let result;
  try {
    result = await startOAuth2Flow(
      {
        authorizeUrl: "https://slack.com/oauth/v2/authorize",
        tokenExchangeUrl: "https://slack.com/api/oauth.v2.access",
        scopes: BOT_SCOPES,
        clientId,
        clientSecret,
        scopeSeparator: ",",
        authorizeParams: {
          user_scope: USER_SCOPES.join(","),
        },
      },
      {
        openUrl: (url) => openInHostBrowser(url),
      },
      {
        callbackTransport: "loopback",
        loopbackPort: SLACK_LOOPBACK_PORT,
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, "Slack OAuth install flow failed");
    return {
      success: false,
      hasBotToken: false,
      hasUserToken: false,
      error: `OAuth flow failed: ${msg}`,
    };
  }

  // Slack's oauth.v2.access returns:
  //   access_token: "xoxb-..." (bot token)
  //   authed_user: { access_token: "xoxp-..." } (user token)
  const raw = result.rawTokenResponse;
  const botToken = raw.access_token as string | undefined;
  const authedUser = raw.authed_user as { access_token?: string } | undefined;
  const userToken = authedUser?.access_token as string | undefined;

  if (!botToken) {
    log.error(
      { rawKeys: Object.keys(raw) },
      "Slack OAuth response missing bot access_token",
    );
    return {
      success: false,
      hasBotToken: false,
      hasUserToken: false,
      error:
        "Slack OAuth response did not include a bot token (access_token). The app may not have bot scopes configured.",
    };
  }

  log.info(
    { hasBotToken: true, hasUserToken: !!userToken },
    "Slack OAuth tokens received, storing via setSlackChannelConfig",
  );

  // Store bot token (and user token if present) via the Slack channel handler,
  // which validates tokens and persists workspace metadata.
  const configResult = await setSlackChannelConfig(
    botToken,
    undefined, // app_token already stored via credential_store prompt
    userToken,
  );

  if (!configResult.success) {
    return {
      success: false,
      hasBotToken: false,
      hasUserToken: false,
      error: configResult.error ?? "Failed to store Slack tokens",
    };
  }

  return {
    success: true,
    hasBotToken: true,
    hasUserToken: !!userToken,
  };
}
