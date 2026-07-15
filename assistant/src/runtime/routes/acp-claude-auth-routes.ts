/**
 * Route definitions for the "Connect Claude" ACP OAuth flow.
 *
 * On a local/desktop host the daemon binds a loopback callback server, hands
 * the web client an authorize URL to open, and captures + exchanges the
 * redirect itself. On a containerized (cloud) host — where no such loopback
 * exists — the user pastes the redirect's `code#state` back for the daemon to
 * exchange.
 *
 * POST /v1/acp/claude/auth/start — on a local host bind a loopback callback and
 *   return `{ mode: "loopback", authorize_url, state }`, capturing the redirect
 *   in the background. On a containerized (cloud) host — where no loopback the
 *   user's browser can reach exists — return `{ mode: "manual", authorize_url,
 *   state }` against Claude's manual redirect page; the user copies the
 *   `code#state` it renders back into the web client.
 * GET  /v1/acp/claude/auth/status/:state — poll a loopback flow's status
 *   (`pending` | `connected` | `error`) so the web client knows when the token
 *   has landed.
 * POST /v1/acp/claude/auth/exchange — complete a manual/cloud flow: accept the
 *   pasted `code#state` (or a raw code + state), exchange it, and store the
 *   Claude OAuth token.
 *
 * The cloud manual path is flag-gated + fail-closed (see `handleStartAuth`).
 */

import { z } from "zod";

import {
  buildClaudeAuthorizeUrl,
  CLAUDE_MANUAL_REDIRECT_URI,
  CLAUDE_OAUTH_CONFIG,
  parseManualClaudeCode,
  storeAcpClaudeToken,
} from "../../acp/acp-claude-oauth.js";
import { isAcpClaudeOauthConnectEnabled } from "../../acp/acp-oauth-connect-flag.js";
import { getIsContainerized } from "../../config/env-registry.js";
import { loadConfig } from "../../config/loader.js";
import {
  exchangeCodeForTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  prepareOAuth2Flow,
} from "../../security/oauth2.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("acp-claude-auth");

// Claude's OAuth client requires the loopback redirect path to be exactly
// `/callback`, not oauth2.ts's default `/oauth/callback`.
const CLAUDE_LOOPBACK_CALLBACK_PATH = "/callback";

// ---------------------------------------------------------------------------
// Pending-flow tracking (shared by the loopback + manual/cloud branches)
// ---------------------------------------------------------------------------

type FlowStatus = "pending" | "connected" | "error";

interface PendingFlow {
  status: FlowStatus;
  error?: string;
  createdAt: number;
  /**
   * Cloud/manual path only: the PKCE verifier + redirect the pasted code is
   * exchanged with. Absent on loopback flows (the daemon exchanges those
   * itself), which also keeps loopback entries from being exchangeable via the
   * manual `exchange` route.
   */
  codeVerifier?: string;
  redirectUri?: string;
}

interface StartResponse {
  mode: "loopback" | "manual";
  authorize_url: string;
  state: string;
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

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Route entry point. Locally the daemon captures the redirect on a loopback;
 * on a containerized (cloud) host it can't bind a loopback the user's browser
 * reaches, so it falls back to the manual `code#state` paste path.
 *
 * The manual path performs Claude subscription inference OFF the user's device,
 * which is the ToS-sensitive pattern documented in
 * `.private/acp-claude-code-tos-memo.md` — so it is flag-gated and fails closed
 * (a clear error, never a broken loopback attempt) when the flag is off.
 */
async function handleStartAuth(
  _args: RouteHandlerArgs,
): Promise<StartResponse> {
  cleanupExpiredFlows();

  if (getIsContainerized()) {
    if (!isAcpClaudeOauthConnectEnabled(loadConfig())) {
      throw new ForbiddenError(
        "Connect Claude is not enabled for this workspace.",
      );
    }
    return handleStartManualAuth();
  }

  return handleStartLocalAuth();
}

async function handleStartLocalAuth(): Promise<StartResponse> {
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
      await storeAcpClaudeToken(result.tokens.accessToken);
      markFlow(flow.state, "connected");
      log.info("ACP Claude local OAuth flow connected");
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      markFlow(flow.state, "error", message);
      log.error({ err: message }, "ACP Claude local OAuth flow failed");
    });

  return {
    mode: "loopback",
    authorize_url: flow.authorizeUrl,
    state: flow.state,
  };
}

/**
 * Cloud/manual path: build a PKCE authorize URL against Claude's manual
 * redirect page and stash the verifier keyed by `state` so `handleExchange` can
 * complete the flow once the user pastes the `code#state` it renders back.
 */
function handleStartManualAuth(): StartResponse {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  pendingFlows.set(state, {
    status: "pending",
    createdAt: Date.now(),
    codeVerifier,
    redirectUri: CLAUDE_MANUAL_REDIRECT_URI,
  });

  const authorizeUrl = buildClaudeAuthorizeUrl(CLAUDE_MANUAL_REDIRECT_URI, {
    codeChallenge,
    state,
  });

  return { mode: "manual", authorize_url: authorizeUrl, state };
}

/**
 * Complete a manual/cloud flow. The redirect page renders a `code#state` string
 * the web client may paste verbatim into `code`, so split it when the `#`
 * separator is present (or when no separate `state` was supplied). A raw code
 * plus an explicit `state` is also accepted.
 */
async function handleExchange(args: RouteHandlerArgs): Promise<{ ok: true }> {
  const body = (args.body ?? {}) as { code?: string; state?: string };
  const rawCode = (body.code ?? "").trim();
  let code = rawCode;
  let state = (body.state ?? "").trim();

  if (rawCode.includes("#") || !state) {
    try {
      ({ code, state } = parseManualClaudeCode(rawCode));
    } catch (err) {
      throw new BadRequestError(
        err instanceof Error
          ? err.message
          : "Malformed Claude authorization code.",
      );
    }
  }

  const pending = pendingFlows.get(state);
  // Only manual flows carry a verifier; a loopback entry (no verifier) is
  // completed by the daemon itself and must not be exchangeable here.
  if (!pending || pending.codeVerifier === undefined) {
    throw new BadRequestError(
      "Invalid or expired state. Restart the Connect Claude flow.",
    );
  }

  if (Date.now() - pending.createdAt > PENDING_FLOW_TTL_MS) {
    pendingFlows.delete(state);
    throw new BadRequestError(
      "Connect Claude flow expired. Restart the Connect Claude flow.",
    );
  }

  // Surface a bad code / token-endpoint failure as a client-actionable 400 and
  // mark the flow errored (mirroring the loopback path) so it isn't left pending.
  try {
    const result = await exchangeCodeForTokens(
      CLAUDE_OAUTH_CONFIG,
      code,
      pending.redirectUri ?? CLAUDE_MANUAL_REDIRECT_URI,
      pending.codeVerifier,
    );
    await storeAcpClaudeToken(result.tokens.accessToken);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markFlow(state, "error", message);
    log.error({ err: message }, "ACP Claude manual OAuth flow failed");
    throw new BadRequestError(
      `Failed to exchange Claude authorization code: ${message}`,
    );
  }

  pendingFlows.delete(state);
  log.info("ACP Claude manual OAuth flow connected");
  return { ok: true };
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
    summary: "Start Connect Claude OAuth flow",
    description:
      "Return a PKCE authorize URL plus a state token. On a local host (" +
      "`mode: loopback`) the daemon binds a loopback callback and captures the " +
      "redirect itself; on a containerized host (`mode: manual`) it targets " +
      "Claude's manual redirect page and the web client posts the pasted " +
      "`code#state` back to `.../auth/exchange`.",
    tags: ["acp"],
    responseBody: z.object({
      mode: z.enum(["loopback", "manual"]),
      authorize_url: z.string(),
      state: z.string(),
    }),
    handler: handleStartAuth,
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
  {
    operationId: "acp_claude_auth_exchange",
    endpoint: "acp/claude/auth/exchange",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Exchange a manual Connect Claude authorization code",
    description:
      "Complete a containerized/manual Connect Claude flow: accept the pasted " +
      "`code#state` (or a raw code plus state), exchange it against Claude's " +
      "manual redirect URI, and store the Claude OAuth token.",
    tags: ["acp"],
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
