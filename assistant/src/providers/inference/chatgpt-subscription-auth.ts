/**
 * Shared pieces of the "ChatGPT Subscription" sign-in.
 *
 * Every entry point into the flow (the daemon's device-code routes, the
 * daemon's copy-paste PKCE routes, and the `assistant inference providers
 * login-chatgpt` CLI command) authenticates against the same OAuth client and
 * lands its tokens under the same credential prefix, so the client config and
 * the credential writes live here rather than in each caller.
 *
 * The CLI is a separate process with no database handle, so it uses
 * `storeChatgptSubscriptionCredentials` plus its own IPC connection upsert;
 * in-daemon callers use `storeChatgptSubscriptionTokens`, which does both.
 */

import { getDb } from "../../persistence/db-connection.js";
import type { OAuth2Config, OAuth2TokenResult } from "../../security/oauth2.js";
import { setSecureKeyAsync } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import { CHATGPT_SUBSCRIPTION_CONNECTION_NAME } from "./auth.js";
import {
  createConnection,
  getConnection,
  updateConnection,
} from "./connections.js";

const log = getLogger("chatgpt-subscription-auth");

export { CHATGPT_SUBSCRIPTION_CONNECTION_NAME };

/** OpenAI's Codex OAuth client. PKCE only, no client secret. */
export const OPENAI_OAUTH_CONFIG: OAuth2Config = {
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenExchangeUrl: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  scopes: ["openid", "profile", "email", "offline_access"],
  scopeSeparator: " ",
  authorizeParams: { id_token_add_organizations: "true" },
};

/** Credential-store prefix holding the subscription's access/refresh tokens. */
export const CHATGPT_CREDENTIAL_PREFIX = "credential/chatgpt";

export const CHATGPT_ACCESS_TOKEN_CREDENTIAL = `${CHATGPT_CREDENTIAL_PREFIX}/access_token`;

/** Auth block stamped on the `chatgpt-subscription` provider connection. */
export const CHATGPT_SUBSCRIPTION_AUTH_INPUT = {
  type: "oauth_subscription" as const,
  credential: CHATGPT_ACCESS_TOKEN_CREDENTIAL,
};

/**
 * Write the subscription's tokens to the credential store.
 *
 * Throws when a write fails: a half-stored credential set leaves the provider
 * connection pointing at a token the assistant cannot use.
 */
export async function storeChatgptSubscriptionCredentials(
  tokens: OAuth2TokenResult,
): Promise<void> {
  const accessStored = await setSecureKeyAsync(
    CHATGPT_ACCESS_TOKEN_CREDENTIAL,
    tokens.accessToken,
  );
  if (!accessStored) {
    log.error("Failed to store ChatGPT access token in CES");
    throw new Error("Failed to store access token");
  }

  if (tokens.refreshToken) {
    const refreshStored = await setSecureKeyAsync(
      `${CHATGPT_CREDENTIAL_PREFIX}/refresh_token`,
      tokens.refreshToken,
    );
    if (!refreshStored) {
      log.error("Failed to store ChatGPT refresh token in CES");
      throw new Error("Failed to store refresh token");
    }
  }

  if (tokens.expiresIn) {
    const expiresAt = Math.floor(Date.now() / 1000 + tokens.expiresIn);
    await setSecureKeyAsync(
      `${CHATGPT_CREDENTIAL_PREFIX}/expires_at`,
      String(expiresAt),
    );
  }
}

/**
 * Store the subscription's tokens and point the `chatgpt-subscription` provider
 * connection at them, creating the connection when it does not exist yet.
 */
export async function storeChatgptSubscriptionTokens(
  tokens: OAuth2TokenResult,
): Promise<void> {
  await storeChatgptSubscriptionCredentials(tokens);

  const db = getDb();
  const existing = getConnection(db, CHATGPT_SUBSCRIPTION_CONNECTION_NAME);

  if (existing) {
    // Stamp the provider with the auth: this row IS the subscription route
    // (auth modality = provider identity), and dispatch derives the openai
    // upstream from the identity per-request. Stamping also heals a
    // claiming row whose provider would otherwise misroute the fresh token.
    const updateResult = updateConnection(
      db,
      CHATGPT_SUBSCRIPTION_CONNECTION_NAME,
      { auth: CHATGPT_SUBSCRIPTION_AUTH_INPUT, provider: "chatgpt" },
    );
    if (!updateResult.ok) {
      log.error(
        { error: updateResult.error },
        "Failed to update chatgpt-subscription connection",
      );
      throw new Error("Failed to update connection");
    }
    return;
  }

  const createResult = createConnection(db, {
    name: CHATGPT_SUBSCRIPTION_CONNECTION_NAME,
    provider: "chatgpt",
    auth: CHATGPT_SUBSCRIPTION_AUTH_INPUT,
  });
  if (!createResult.ok) {
    log.error(
      { error: createResult.error },
      "Failed to create chatgpt-subscription connection",
    );
    throw new Error("Failed to create connection");
  }
}
