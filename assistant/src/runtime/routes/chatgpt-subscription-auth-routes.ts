/**
 * Route definitions for ChatGPT subscription ("Sign in with ChatGPT") auth.
 *
 * Device code is the primary path: the daemon mints a short user code, the user
 * types it at OpenAI's device page, and the daemon polls in the background and
 * stores the tokens itself. The copy-paste PKCE path stays as the fallback for
 * accounts that have not enabled device-code authorization for Codex.
 *
 * POST /v1/inference/chatgpt-subscription/device-auth: mint a user code and
 *   start the background poll. Returns `{ state, user_code, verification_url,
 *   expires_at, interval_seconds }`.
 * GET /v1/inference/chatgpt-subscription/device-auth/status/:state: poll the
 *   device flow's status (`pending` | `connected` | `error`).
 * DELETE /v1/inference/chatgpt-subscription/device-auth/:state: stop the
 *   background poll for an abandoned flow.
 *
 * POST /v1/inference/chatgpt-subscription/auth — generate a PKCE authorize
 *   URL for the user to visit. Returns `{ authorize_url, state }`.
 * POST /v1/inference/chatgpt-subscription/auth/exchange — accept the
 *   authorization code + state from the redirect and exchange it for tokens.
 */

import { z } from "zod";

import { storeChatgptSubscriptionTokens } from "../../providers/inference/chatgpt-subscription-auth.js";
import { OPENAI_OAUTH_CONFIG } from "../../providers/inference/chatgpt-subscription-credentials.js";
import {
  exchangeCodeForTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from "../../security/oauth2.js";
import {
  completeDeviceAuth,
  DeviceAuthError,
  OPENAI_DEVICE_AUTH_MAX_LIFETIME_MS,
  requestDeviceCode,
} from "../../security/openai-device-auth.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import { createPendingFlowRegistry } from "./oauth-pending-flows.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("chatgpt-subscription-auth-routes");

const REDIRECT_URI = "http://localhost:1455/auth/callback";

/**
 * Copy-paste PKCE flows, keyed by the `state` in the authorize URL. The
 * verifier is held until the user pastes the redirect's code back.
 */
const pendingPkceFlows = createPendingFlowRegistry<{ codeVerifier: string }>();

/**
 * Device-code flows, keyed by OpenAI's `device_auth_id`. Each entry carries the
 * controller that stops its background poll. Entries outlive the device code
 * itself so a client polling right after expiry still reads the terminal status
 * instead of a 404.
 */
const pendingDeviceFlows = createPendingFlowRegistry<{
  abort: AbortController;
}>({
  ttlMs: OPENAI_DEVICE_AUTH_MAX_LIFETIME_MS + 5 * 60 * 1000,
});

/**
 * The one device flow whose background poll is still running. A sign-in is a
 * single-user act at a single moment, so starting one ends whichever came
 * before it rather than leaving two polls hitting OpenAI every few seconds.
 */
let inFlightDeviceAuthId: string | null = null;

/** Stop a flow's poll and record why, when it has not already settled. */
function cancelDeviceFlow(state: string): boolean {
  const flow = pendingDeviceFlows.get(state);
  if (!flow || flow.status !== "pending") {
    return false;
  }
  flow.abort.abort();
  pendingDeviceFlows.mark(state, "error", {
    error: "The sign-in was cancelled.",
    errorCode: "aborted",
  });
  if (inFlightDeviceAuthId === state) {
    inFlightDeviceAuthId = null;
  }
  return true;
}

/** Release the in-flight slot once this flow's poll is done with it. */
function releaseDeviceFlow(state: string): void {
  if (inFlightDeviceAuthId === state) {
    inFlightDeviceAuthId = null;
  }
}

/**
 * Whether `state` is still the unsettled flow the daemon is running.
 *
 * A cancel or a newer sign-in can land after the poll has returned an
 * authorization code but before the exchange and the credential writes finish.
 * Checking this on either side of the store keeps an abandoned flow from
 * writing tokens the user asked it to drop, or from overwriting the
 * credentials of the sign-in that replaced it.
 */
function isDeviceFlowStillLive(state: string): boolean {
  return (
    inFlightDeviceAuthId === state &&
    pendingDeviceFlows.get(state)?.status === "pending"
  );
}

/** Failures the user caused or waited out: expected ends, not defects. */
function isExpectedDeviceAuthEnd(code: string): boolean {
  return code === "aborted" || code === "expired_token";
}

interface DeviceAuthStartResponse {
  state: string;
  user_code: string;
  verification_url: string;
  expires_at: string;
  interval_seconds: number;
}

interface FlowStatusResponse {
  status: "pending" | "connected" | "error";
  error?: string;
  error_code?: string;
}

// ---------------------------------------------------------------------------
// Device-code handlers
// ---------------------------------------------------------------------------

/**
 * Mint a device code and return it immediately. The approval poll and the
 * token exchange run in the background, one per `device_auth_id`, and flip the
 * tracked flow's status when they settle.
 */
async function handleStartDeviceAuth(
  _args: RouteHandlerArgs,
): Promise<DeviceAuthStartResponse> {
  pendingDeviceFlows.cleanupExpired();
  if (inFlightDeviceAuthId) {
    cancelDeviceFlow(inFlightDeviceAuthId);
  }

  const request = await requestDeviceCode(OPENAI_OAUTH_CONFIG.clientId);
  const abort = new AbortController();
  pendingDeviceFlows.start(request.deviceAuthId, { abort });
  inFlightDeviceAuthId = request.deviceAuthId;

  void completeDeviceAuth(OPENAI_OAUTH_CONFIG, request, {
    signal: abort.signal,
  })
    .then(async (result) => {
      if (!isDeviceFlowStillLive(request.deviceAuthId)) {
        log.warn(
          "ChatGPT subscription device auth flow settled after it was dropped; discarding its tokens",
        );
        return;
      }
      await storeChatgptSubscriptionTokens(result.tokens);
      if (!isDeviceFlowStillLive(request.deviceAuthId)) {
        log.warn(
          "ChatGPT subscription device auth flow was dropped while its tokens were stored",
        );
        return;
      }
      pendingDeviceFlows.mark(request.deviceAuthId, "connected");
      log.info("ChatGPT subscription device auth flow connected");
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const errorCode =
        err instanceof DeviceAuthError ? err.code : "device_auth_failed";
      pendingDeviceFlows.mark(request.deviceAuthId, "error", {
        error: message,
        errorCode,
      });
      const detail = { err: message, code: errorCode };
      if (isExpectedDeviceAuthEnd(errorCode)) {
        log.warn(detail, "ChatGPT subscription device auth flow ended");
      } else {
        log.error(detail, "ChatGPT subscription device auth flow failed");
      }
    })
    .finally(() => releaseDeviceFlow(request.deviceAuthId));

  return {
    state: request.deviceAuthId,
    user_code: request.userCode,
    verification_url: request.verificationUrl,
    expires_at: request.expiresAt,
    interval_seconds: request.intervalSeconds,
  };
}

function handleDeviceAuthStatus({
  pathParams,
}: RouteHandlerArgs): FlowStatusResponse {
  const { state } = pathParams as { state: string };
  const report = pendingDeviceFlows.readStatus(state);

  if (!report) {
    throw new NotFoundError(
      "No active ChatGPT device sign-in for the given state. Restart the sign-in flow.",
    );
  }

  const response: FlowStatusResponse = { status: report.status };
  if (report.error !== undefined) {
    response.error = report.error;
  }
  if (report.errorCode !== undefined) {
    response.error_code = report.errorCode;
  }
  return response;
}

/**
 * Stop an abandoned flow's background poll. Without this an abandoned sign-in
 * keeps polling OpenAI every few seconds until the code expires.
 */
function handleCancelDeviceAuth({ pathParams }: RouteHandlerArgs): {
  cancelled: boolean;
} {
  const { state } = pathParams as { state: string };

  if (!pendingDeviceFlows.get(state)) {
    throw new NotFoundError(
      "No active ChatGPT device sign-in for the given state.",
    );
  }

  const cancelled = cancelDeviceFlow(state);
  if (cancelled) {
    log.warn("ChatGPT subscription device auth flow cancelled by the client");
  }
  return { cancelled };
}

// ---------------------------------------------------------------------------
// Copy-paste PKCE handlers
// ---------------------------------------------------------------------------

async function handleStartAuth(_args: RouteHandlerArgs) {
  pendingPkceFlows.cleanupExpired();

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  pendingPkceFlows.start(state, { codeVerifier });

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

  const pending = pendingPkceFlows.get(state);
  if (!pending) {
    throw new BadRequestError(
      "Invalid or expired state parameter. Please restart the auth flow.",
    );
  }

  pendingPkceFlows.delete(state);

  if (pendingPkceFlows.isExpired(pending)) {
    throw new BadRequestError(
      "Auth flow expired. Please restart the auth flow.",
    );
  }

  const { tokens } = await exchangeCodeForTokens(
    OPENAI_OAUTH_CONFIG,
    code,
    REDIRECT_URI,
    pending.codeVerifier,
  );

  await storeChatgptSubscriptionTokens(tokens);

  log.info("ChatGPT subscription auth flow completed successfully");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "inference_chatgpt_subscription_device_auth",
    endpoint: "inference/chatgpt-subscription/device-auth",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Start ChatGPT subscription device-code sign-in",
    description:
      "Mint a short user code the user types at OpenAI's device page, and " +
      "start a background poll that stores the tokens and upserts the " +
      "provider connection once the sign-in is approved. Returns immediately; " +
      "poll `.../device-auth/status/{state}` for the outcome. The account must " +
      "have device-code authorization for Codex enabled in its ChatGPT " +
      "security settings.",
    tags: ["inference"],
    responseBody: z.object({
      state: z.string(),
      user_code: z.string(),
      verification_url: z.string(),
      expires_at: z.string(),
      interval_seconds: z.number(),
    }),
    handler: handleStartDeviceAuth,
  },
  {
    operationId: "inference_chatgpt_subscription_device_auth_status",
    endpoint: "inference/chatgpt-subscription/device-auth/status/:state",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Poll ChatGPT subscription device-code sign-in status",
    description:
      "Returns the current status of an in-flight device-code sign-in " +
      "(pending/connected/error) so the client knows when the tokens have " +
      "landed. A failure carries OpenAI's error code in `error_code`.",
    tags: ["inference"],
    pathParams: [{ name: "state" }],
    additionalResponses: {
      "404": { description: "No active device sign-in for the given state" },
    },
    responseBody: z.object({
      status: z.enum(["pending", "connected", "error"]),
      error: z.string().optional(),
      error_code: z.string().optional(),
    }),
    handler: handleDeviceAuthStatus,
  },
  {
    operationId: "inference_chatgpt_subscription_device_auth_cancel",
    endpoint: "inference/chatgpt-subscription/device-auth/:state",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Cancel a ChatGPT subscription device-code sign-in",
    description:
      "Stop the background poll for a device-code sign-in the user walked " +
      "away from, and mark the flow `error` with code `aborted`. A flow that " +
      "already settled is left as it is. 404s an unknown state.",
    tags: ["inference"],
    pathParams: [{ name: "state" }],
    additionalResponses: {
      "404": { description: "No active device sign-in for the given state" },
    },
    responseBody: z.object({
      cancelled: z.boolean(),
    }),
    handler: handleCancelDeviceAuth,
  },
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
