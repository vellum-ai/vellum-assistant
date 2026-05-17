/**
 * Route definitions for ChatGPT subscription OAuth authentication via the
 * OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * POST /v1/inference/chatgpt-subscription/auth — initiate a device-code flow
 *   against OpenAI. Returns the user code + verification URI immediately so
 *   the web UI can display them. Token polling, CES storage, and connection
 *   upsert happen asynchronously in the background.
 *
 * GET /v1/inference/chatgpt-subscription/auth/status — return the current
 *   in-flight flow status so the web UI can poll for completion.
 *
 * The device-code flow replaced an earlier PKCE loopback flow which only
 * worked when the daemon shared a network namespace with the user's browser
 * (i.e. desktop installs). Device code works in cloud-hosted and
 * containerised daemons because the user activates the code on a separate
 * device — no localhost callback required.
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
import {
  DeviceCodeError,
  OPENAI_DEVICE_CODE_CONFIG,
  pollForToken,
  requestDeviceCode,
} from "../../security/oauth2-device-code.js";
import { setSecureKeyAsync } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("chatgpt-subscription-auth");

const CONNECTION_NAME = "chatgpt-subscription";

// ---------------------------------------------------------------------------
// In-flight flow state
//
// Only one device-code flow can be active at a time. This matches the
// historical behaviour of the PKCE loopback handler (which bound port 1455)
// and keeps the polling endpoint trivial — the web UI just asks "what's the
// current state?" instead of tracking per-flow ids.
// ---------------------------------------------------------------------------

type FlowStatus = "idle" | "pending" | "completed" | "failed";

interface FlowState {
  status: FlowStatus;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  /** Unix epoch ms at which the device code expires. */
  expiresAt?: number;
  /** Unix epoch ms when the current flow was started. */
  startedAt?: number;
  errorCode?: string;
  errorMessage?: string;
}

let currentFlow: FlowState = { status: "idle" };

/** @internal Test-only: reset module state between cases. */
export function _resetChatgptAuthState(): void {
  currentFlow = { status: "idle" };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleStartAuth(_args: RouteHandlerArgs) {
  const config = getConfigReadOnly();
  if (!isAssistantFeatureFlagEnabled("chatgpt-subscription-auth", config)) {
    throw new BadRequestError(
      "ChatGPT subscription auth is not enabled for this assistant.",
    );
  }

  const init = await requestDeviceCode(OPENAI_DEVICE_CODE_CONFIG);

  const startedAt = Date.now();
  currentFlow = {
    status: "pending",
    userCode: init.userCode,
    verificationUri: init.verificationUri,
    verificationUriComplete: init.verificationUriComplete,
    expiresAt: startedAt + init.expiresIn * 1000,
    startedAt,
  };

  void runBackgroundPoll(init.deviceCode, init.interval, init.expiresIn);

  return {
    device_code: init.deviceCode,
    user_code: init.userCode,
    verification_uri: init.verificationUri,
    verification_uri_complete: init.verificationUriComplete,
    expires_in: init.expiresIn,
    interval: init.interval,
  };
}

async function handleAuthStatus(_args: RouteHandlerArgs) {
  const config = getConfigReadOnly();
  if (!isAssistantFeatureFlagEnabled("chatgpt-subscription-auth", config)) {
    throw new BadRequestError(
      "ChatGPT subscription auth is not enabled for this assistant.",
    );
  }

  return {
    status: currentFlow.status,
    user_code: currentFlow.userCode,
    verification_uri: currentFlow.verificationUri,
    verification_uri_complete: currentFlow.verificationUriComplete,
    expires_at: currentFlow.expiresAt,
    started_at: currentFlow.startedAt,
    error_code: currentFlow.errorCode,
    error_message: currentFlow.errorMessage,
  };
}

// ---------------------------------------------------------------------------
// Background polling
// ---------------------------------------------------------------------------

async function runBackgroundPoll(
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<void> {
  try {
    const tokens = await pollForToken(
      OPENAI_DEVICE_CODE_CONFIG,
      deviceCode,
      interval,
      expiresIn,
    );

    const accessStored = await setSecureKeyAsync(
      "credential/chatgpt/access_token",
      tokens.accessToken,
    );
    if (!accessStored) {
      markFailed("ces_store_failed", "Failed to store access token in CES");
      return;
    }

    if (tokens.refreshToken) {
      const refreshStored = await setSecureKeyAsync(
        "credential/chatgpt/refresh_token",
        tokens.refreshToken,
      );
      if (!refreshStored) {
        markFailed("ces_store_failed", "Failed to store refresh token in CES");
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
        markFailed(
          "connection_update_failed",
          `Failed to update connection: ${updateResult.error}`,
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
        markFailed(
          "connection_create_failed",
          `Failed to create connection: ${createResult.error}`,
        );
        return;
      }
    }

    currentFlow = { ...currentFlow, status: "completed" };
    log.info("ChatGPT subscription auth flow completed successfully");
  } catch (err) {
    const code = err instanceof DeviceCodeError ? err.code : "request_failed";
    const message = err instanceof Error ? err.message : String(err);
    markFailed(code, message);
  }
}

function markFailed(code: string, message: string): void {
  log.error({ code, message }, "ChatGPT subscription auth flow failed");
  currentFlow = {
    ...currentFlow,
    status: "failed",
    errorCode: code,
    errorMessage: message,
  };
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
    summary: "Start ChatGPT subscription device-code OAuth flow",
    description:
      "Initiate an OAuth 2.0 device authorization grant against OpenAI. Returns the user code and verification URI for the client to display. Token polling, CES storage, and connection upsert happen in the background — poll GET /v1/inference/chatgpt-subscription/auth/status to observe completion.",
    tags: ["inference"],
    responseBody: z.object({
      device_code: z.string(),
      user_code: z.string(),
      verification_uri: z.string(),
      verification_uri_complete: z.string().optional(),
      expires_in: z.number(),
      interval: z.number(),
    }),
    handler: handleStartAuth,
  },
  {
    operationId: "inference_chatgpt_subscription_auth_status",
    endpoint: "inference/chatgpt-subscription/auth/status",
    method: "GET",
    policyKey: "inference/provider-connections",
    summary: "Get current ChatGPT subscription auth flow status",
    description:
      "Returns the state of the in-flight (or most recently completed) ChatGPT subscription device-code flow. Clients poll this endpoint after POST /v1/inference/chatgpt-subscription/auth to detect when the user has completed authorization on their browser.",
    tags: ["inference"],
    responseBody: z.object({
      status: z.enum(["idle", "pending", "completed", "failed"]),
      user_code: z.string().optional(),
      verification_uri: z.string().optional(),
      verification_uri_complete: z.string().optional(),
      expires_at: z.number().optional(),
      started_at: z.number().optional(),
      error_code: z.string().optional(),
      error_message: z.string().optional(),
    }),
    handler: handleAuthStatus,
  },
];
