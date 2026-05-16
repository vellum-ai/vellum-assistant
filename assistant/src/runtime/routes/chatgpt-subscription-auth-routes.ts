/**
 * Route definitions for ChatGPT subscription OAuth authentication.
 *
 * POST /v1/inference/chatgpt-subscription/auth — initiate a PKCE OAuth flow
 *   against OpenAI, returning the authorize URL for the web UI to open in a
 *   popup. The callback, token exchange, CES storage, and connection
 *   upsert happen asynchronously in the background.
 */

import { z } from "zod";

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfigReadOnly } from "../../config/loader.js";
import { getDb } from "../../memory/db-connection.js";
import {
  createConnection,
  getConnection,
  updateConnection,
} from "../../providers/inference/connections.js";
import type { OAuth2Config } from "../../security/oauth2.js";
import { prepareOAuth2Flow } from "../../security/oauth2.js";
import { setSecureKeyAsync } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("chatgpt-subscription-auth");

// ---------------------------------------------------------------------------
// OAuth config (mirrors OPENAI_CODEX_OAUTH_CONFIG from CLI)
// ---------------------------------------------------------------------------

const OPENAI_CHATGPT_OAUTH_CONFIG: OAuth2Config = {
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenExchangeUrl: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  scopes: ["openid", "profile", "email", "offline_access"],
  scopeSeparator: " ",
  authorizeParams: { id_token_add_organizations: "true" },
};

const LOOPBACK_PORT = 1455;
const LOOPBACK_CALLBACK_PATH = "/auth/callback";
const CONNECTION_NAME = "chatgpt-subscription";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleStartAuth(_args: RouteHandlerArgs) {
  const config = getConfigReadOnly();
  if (!isAssistantFeatureFlagEnabled("chatgpt-subscription-auth", config)) {
    throw new BadRequestError(
      "ChatGPT subscription auth is not enabled for this assistant.",
    );
  }

  // Prepare the OAuth flow: starts the loopback server and builds the auth URL
  // without blocking on the callback.
  const prepared = await prepareOAuth2Flow(OPENAI_CHATGPT_OAUTH_CONFIG, {
    callbackTransport: "loopback",
    loopbackPort: LOOPBACK_PORT,
    loopbackCallbackPath: LOOPBACK_CALLBACK_PATH,
  });

  // Run the background completion: wait for the callback, exchange code for
  // tokens, store in CES, and upsert the provider connection. Errors are
  // logged but do not surface to the caller — the web UI will poll connection
  // status separately.
  prepared.completion
    .then(async (result) => {
      const { tokens } = result;

      // Store tokens in CES
      const accessStored = await setSecureKeyAsync(
        "credential/chatgpt/access_token",
        tokens.accessToken,
      );
      if (!accessStored) {
        log.error("Failed to store ChatGPT access token in CES");
        return;
      }

      if (tokens.refreshToken) {
        const refreshStored = await setSecureKeyAsync(
          "credential/chatgpt/refresh_token",
          tokens.refreshToken,
        );
        if (!refreshStored) {
          log.error("Failed to store ChatGPT refresh token in CES");
          return;
        }
      }

      if (tokens.expiresIn) {
        const expiresAt = Math.floor(Date.now() / 1000 + tokens.expiresIn);
        await setSecureKeyAsync(
          "credential/chatgpt/expires_at",
          String(expiresAt),
        );
      }

      // Upsert provider connection
      const db = getDb();
      const authInput = {
        type: "oauth_subscription" as const,
        credential: "credential/chatgpt/access_token",
      };

      const existing = getConnection(db, CONNECTION_NAME);
      if (existing) {
        const updateResult = updateConnection(db, CONNECTION_NAME, {
          auth: authInput,
        });
        if (!updateResult.ok) {
          log.error(
            { error: updateResult.error },
            "Failed to update chatgpt-subscription connection",
          );
          return;
        }
      } else {
        const createResult = createConnection(db, {
          name: CONNECTION_NAME,
          provider: "openai",
          auth: authInput,
        });
        if (!createResult.ok) {
          log.error(
            { error: createResult.error },
            "Failed to create chatgpt-subscription connection",
          );
          return;
        }
      }

      log.info("ChatGPT subscription auth flow completed successfully");
    })
    .catch((err: unknown) => {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "ChatGPT subscription auth flow failed",
      );
    });

  return { authorize_url: prepared.authorizeUrl };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "inference_chatgpt_subscription_auth",
    endpoint: "inference/chatgpt-subscription/auth",
    method: "POST",
    policyKey: "inference/provider-connections",
    summary: "Start ChatGPT subscription OAuth flow",
    description:
      "Initiate a PKCE OAuth flow against OpenAI for ChatGPT subscription auth. Returns an authorize URL for the client to open in a popup. The callback handling, token exchange, and connection creation happen in the background.",
    tags: ["inference"],
    responseBody: z.object({
      authorize_url: z.string(),
    }),
    handler: handleStartAuth,
  },
];
