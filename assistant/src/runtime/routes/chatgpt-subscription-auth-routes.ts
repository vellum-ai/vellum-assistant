/**
 * Route definitions for ChatGPT subscription OAuth authentication.
 *
 * POST /v1/inference/chatgpt-subscription/auth — generate a PKCE authorize
 *   URL for the user to visit. Returns `{ authorize_url, state }`.
 *
 * POST /v1/inference/chatgpt-subscription/auth/exchange — accept the
 *   authorization code + state from the redirect, exchange for tokens,
 *   store in CES, and upsert the provider connection.
 */

import { z } from "zod";

import { getDb } from "../../persistence/db-connection.js";
import {
  createConnection,
  getConnection,
  updateConnection,
} from "../../providers/inference/connections.js";
import type { OAuth2Config } from "../../security/oauth2.js";
import {
  exchangeCodeForTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from "../../security/oauth2.js";
import { setSecureKeyAsync } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("chatgpt-subscription-auth");

// ---------------------------------------------------------------------------
// OAuth config
// ---------------------------------------------------------------------------

const OPENAI_OAUTH_CONFIG: OAuth2Config = {
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenExchangeUrl: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  scopes: ["openid", "profile", "email", "offline_access"],
  scopeSeparator: " ",
  authorizeParams: { id_token_add_organizations: "true" },
};

const REDIRECT_URI = "http://localhost:1455/auth/callback";
const CONNECTION_NAME = "chatgpt-subscription";

// ---------------------------------------------------------------------------
// Module-level PKCE state storage
// ---------------------------------------------------------------------------

interface PendingAuth {
  codeVerifier: string;
  createdAt: number;
}

const pendingAuths = new Map<string, PendingAuth>();

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Remove entries older than 10 minutes. */
function cleanupExpiredEntries(): void {
  const cutoff = Date.now() - PENDING_AUTH_TTL_MS;
  for (const [key, entry] of pendingAuths) {
    if (entry.createdAt < cutoff) {
      pendingAuths.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleStartAuth(_args: RouteHandlerArgs) {
  cleanupExpiredEntries();

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  pendingAuths.set(state, { codeVerifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_CONFIG.clientId,
    redirect_uri: REDIRECT_URI,
    scope: OPENAI_OAUTH_CONFIG.scopes.join(OPENAI_OAUTH_CONFIG.scopeSeparator),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    ...OPENAI_OAUTH_CONFIG.authorizeParams,
  });

  const authorizeUrl = `${OPENAI_OAUTH_CONFIG.authorizeUrl}?${params.toString()}`;

  return { authorize_url: authorizeUrl, state };
}

async function handleExchange(args: RouteHandlerArgs) {
  const { code, state } = args.body as { code: string; state: string };

  const pending = pendingAuths.get(state);
  if (!pending) {
    throw new Error(
      "Invalid or expired state parameter. Please restart the auth flow.",
    );
  }

  pendingAuths.delete(state);

  // Check TTL
  if (Date.now() - pending.createdAt > PENDING_AUTH_TTL_MS) {
    throw new Error("Auth flow expired. Please restart the auth flow.");
  }

  const { tokens } = await exchangeCodeForTokens(
    OPENAI_OAUTH_CONFIG,
    code,
    REDIRECT_URI,
    pending.codeVerifier,
  );

  // Store tokens in CES
  const accessStored = await setSecureKeyAsync(
    "credential/chatgpt/access_token",
    tokens.accessToken,
  );
  if (!accessStored) {
    log.error("Failed to store ChatGPT access token in CES");
    throw new Error("Failed to store access token");
  }

  if (tokens.refreshToken) {
    const refreshStored = await setSecureKeyAsync(
      "credential/chatgpt/refresh_token",
      tokens.refreshToken,
    );
    if (!refreshStored) {
      log.error("Failed to store ChatGPT refresh token in CES");
      throw new Error("Failed to store refresh token");
    }
  }

  if (tokens.expiresIn) {
    const expiresAt = Math.floor(Date.now() / 1000 + tokens.expiresIn);
    await setSecureKeyAsync("credential/chatgpt/expires_at", String(expiresAt));
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
      throw new Error("Failed to update connection");
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
      throw new Error("Failed to create connection");
    }
  }

  log.info("ChatGPT subscription auth flow completed successfully");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "inference_chatgpt_subscription_auth",
    endpoint: "inference/chatgpt-subscription/auth",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Start ChatGPT subscription OAuth PKCE flow",
    description:
      "Generate a PKCE authorize URL for ChatGPT subscription auth. Returns the URL and state for the client to open in a browser.",
    tags: ["inference"],
    responseBody: z.object({
      authorize_url: z.string(),
      state: z.string(),
    }),
    handler: handleStartAuth,
  },
  {
    operationId: "inference_chatgpt_subscription_auth_exchange",
    endpoint: "inference/chatgpt-subscription/auth/exchange",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Exchange ChatGPT subscription OAuth authorization code",
    description:
      "Accept an authorization code and state from the OAuth redirect, exchange it for tokens, store them in CES, and upsert the provider connection.",
    tags: ["inference"],
    requestBody: z.object({
      code: z.string(),
      state: z.string(),
    }),
    responseBody: z.object({
      ok: z.boolean(),
    }),
    handler: handleExchange,
  },
];
