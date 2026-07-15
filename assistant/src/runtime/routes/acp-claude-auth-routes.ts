/**
 * Route definitions for the "Connect Claude" ACP OAuth flow.
 *
 * This module owns the LOCAL/desktop true-one-click path: the daemon binds a
 * loopback callback server, hands the web client an authorize URL to open, and
 * captures + exchanges the redirect itself — no browser is opened daemon-side.
 *
 * POST /v1/acp/claude/auth/start — bind a loopback callback, return
 *   `{ authorize_url, state }` for the web client to open, and begin capturing
 *   the redirect in the background.
 * GET  /v1/acp/claude/auth/status/:state — poll the flow's status
 *   (`pending` | `connected` | `error`) so the web client knows when the token
 *   has landed.
 *
 * PR 6 adds the CLOUD manual-paste branch to this same module; the pending-flow
 * map + `markFlow` helper are shared so that addition slots in cleanly.
 */

import { z } from "zod";

import {
  CLAUDE_OAUTH_CONFIG,
  storeAcpClaudeToken,
} from "../../acp/acp-claude-oauth.js";
import { ACP_SERVICE } from "../../acp/acp-credentials.js";
import { credentialKey } from "../../security/credential-key.js";
import type { OAuth2FlowResult } from "../../security/oauth2.js";
import { prepareOAuth2Flow } from "../../security/oauth2.js";
import { setSecureKeyAsync } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("acp-claude-auth");

// Claude's OAuth client requires the loopback redirect path to be exactly
// `/callback`, not oauth2.ts's default `/oauth/callback`.
const CLAUDE_LOOPBACK_CALLBACK_PATH = "/callback";

// ACP vault fields for the captured OAuth token's companion metadata. The
// access token itself is written by `storeAcpClaudeToken`.
const CLAUDE_REFRESH_TOKEN_FIELD = "claude_oauth_refresh_token";
const CLAUDE_EXPIRES_AT_FIELD = "claude_oauth_expires_at";

// ---------------------------------------------------------------------------
// Pending-flow tracking (shared with the PR 6 cloud/manual branch)
// ---------------------------------------------------------------------------

type FlowStatus = "pending" | "connected" | "error";

interface PendingFlow {
  status: FlowStatus;
  error?: string;
  createdAt: number;
}

const pendingFlows = new Map<string, PendingFlow>();

const PENDING_FLOW_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Remove entries older than the TTL so the map can't grow unbounded. */
function cleanupExpiredFlows(): void {
  const cutoff = Date.now() - PENDING_FLOW_TTL_MS;
  for (const [state, flow] of pendingFlows) {
    if (flow.createdAt < cutoff) {
      pendingFlows.delete(state);
    }
  }
}

/** Update a tracked flow's status in place, if it still exists. */
function markFlow(state: string, status: FlowStatus, error?: string): void {
  const flow = pendingFlows.get(state);
  if (!flow) {
    return;
  }
  flow.status = status;
  if (error !== undefined) {
    flow.error = error;
  }
}

/**
 * Persist a captured Claude OAuth token (+ refresh token / expiry when
 * present) into the ACP vault so the broker can inject it at agent spawn.
 */
async function persistClaudeTokens(result: OAuth2FlowResult): Promise<void> {
  await storeAcpClaudeToken(result.tokens.accessToken);

  if (result.tokens.refreshToken) {
    await setSecureKeyAsync(
      credentialKey(ACP_SERVICE, CLAUDE_REFRESH_TOKEN_FIELD),
      result.tokens.refreshToken,
    );
  }

  if (result.tokens.expiresIn) {
    const expiresAt = Math.floor(Date.now() / 1000 + result.tokens.expiresIn);
    await setSecureKeyAsync(
      credentialKey(ACP_SERVICE, CLAUDE_EXPIRES_AT_FIELD),
      String(expiresAt),
    );
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleStartLocalAuth(
  _args: RouteHandlerArgs,
): Promise<{ authorize_url: string; state: string }> {
  cleanupExpiredFlows();

  // Bind a fresh loopback port and let the oauth2 layer capture + exchange the
  // redirect. The port is OS-assigned (dynamic): Claude matches localhost
  // redirects port-agnostically per RFC 8252, so a random port sidesteps
  // "port in use" collisions while still producing a valid redirect_uri.
  const flow = await prepareOAuth2Flow(CLAUDE_OAUTH_CONFIG, {
    callbackTransport: "loopback",
    loopbackCallbackPath: CLAUDE_LOOPBACK_CALLBACK_PATH,
  });

  pendingFlows.set(flow.state, { status: "pending", createdAt: Date.now() });

  // The capture + token exchange happen inside `completion`; persist the token
  // when it resolves and flip the flow status so the web client's status poll
  // can react. Runs in the background — the web client opens `authorize_url`.
  void flow.completion
    .then(async (result) => {
      await persistClaudeTokens(result);
      markFlow(flow.state, "connected");
      log.info("ACP Claude local OAuth flow connected");
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      markFlow(flow.state, "error", message);
      log.error({ err: message }, "ACP Claude local OAuth flow failed");
    });

  return { authorize_url: flow.authorizeUrl, state: flow.state };
}

function handleAuthStatus({ pathParams }: RouteHandlerArgs): {
  status: FlowStatus;
  error?: string;
} {
  const { state } = pathParams as { state: string };
  const flow = pendingFlows.get(state);

  if (!flow) {
    throw new NotFoundError(
      "No active Claude auth flow for the given state. Restart the connect flow.",
    );
  }

  return flow.error
    ? { status: flow.status, error: flow.error }
    : { status: flow.status };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "acp_claude_auth_start",
    endpoint: "acp/claude/auth/start",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Start local Connect Claude OAuth flow",
    description:
      "Bind a daemon loopback callback and return a PKCE authorize URL plus a " +
      "state token. The web client opens the URL; the daemon captures the " +
      "redirect, exchanges the code, and stores the Claude OAuth token.",
    tags: ["acp"],
    responseBody: z.object({
      authorize_url: z.string(),
      state: z.string(),
    }),
    handler: handleStartLocalAuth,
  },
  {
    operationId: "acp_claude_auth_status",
    endpoint: "acp/claude/auth/status/:state",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Poll Connect Claude OAuth flow status",
    description:
      "Returns the current status of an in-flight Connect Claude OAuth flow " +
      "(pending/connected/error) so the web client can react once the token " +
      "has landed.",
    tags: ["acp"],
    pathParams: [{ name: "state" }],
    additionalResponses: {
      "404": { description: "No active OAuth flow for the given state" },
    },
    responseBody: z.object({
      status: z.enum(["pending", "connected", "error"]),
      error: z.string().optional(),
    }),
    handler: handleAuthStatus,
  },
];
