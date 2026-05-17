/**
 * Route definitions for ChatGPT subscription OAuth authentication.
 *
 * POST /v1/inference/chatgpt-subscription/auth — initiate a device-code
 *   OAuth flow against OpenAI, returning the verification URI and user code
 *   for the client to display. Token polling, CES storage, and connection
 *   upsert happen asynchronously in the background.
 *
 * GET /v1/inference/chatgpt-subscription/auth/status — poll the current
 *   state of the device-code flow (idle | pending | completed | failed).
 */

import { z } from "zod";

import { getDb } from "../../memory/db-connection.js";
import {
  createConnection,
  getConnection,
  updateConnection,
} from "../../providers/inference/connections.js";
import type { DeviceCodeConfig } from "../../security/oauth2-device-code.js";
import {
  pollForToken,
  requestDeviceCode,
} from "../../security/oauth2-device-code.js";
import { setSecureKeyAsync } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("chatgpt-subscription-auth");

// ---------------------------------------------------------------------------
// OAuth config (device-code flow)
// ---------------------------------------------------------------------------

const OPENAI_CHATGPT_DEVICE_CODE_CONFIG: DeviceCodeConfig = {
  deviceCodeUrl: "https://auth.openai.com/oauth/device/code",
  tokenUrl: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  scopes: ["openid", "profile", "email", "offline_access"],
};

const CONNECTION_NAME = "chatgpt-subscription";

// ---------------------------------------------------------------------------
// Module-level flow state
// ---------------------------------------------------------------------------

type FlowStatus = "idle" | "pending" | "completed" | "failed";

let flowStatus: FlowStatus = "idle";
let flowError: string | undefined;

/** Auto-reset to idle after a terminal state has been read. */
const TERMINAL_STATE_RESET_MS = 30_000;
let resetTimer: ReturnType<typeof setTimeout> | undefined;

function setFlowState(status: FlowStatus, error?: string) {
  flowStatus = status;
  flowError = error;

  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = undefined;
  }

  if (status === "completed" || status === "failed") {
    resetTimer = setTimeout(() => {
      flowStatus = "idle";
      flowError = undefined;
      resetTimer = undefined;
    }, TERMINAL_STATE_RESET_MS);
    if (typeof resetTimer === "object" && "unref" in resetTimer) {
      resetTimer.unref();
    }
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleStartAuth(_args: RouteHandlerArgs) {
  const deviceCodeResult = await requestDeviceCode(
    OPENAI_CHATGPT_DEVICE_CODE_CONFIG,
  );

  setFlowState("pending");

  // Poll for token in the background. When the user completes authorization,
  // store tokens in CES and upsert the provider connection.
  pollForToken(
    OPENAI_CHATGPT_DEVICE_CODE_CONFIG,
    deviceCodeResult.deviceCode,
    deviceCodeResult.interval,
    deviceCodeResult.expiresIn,
  )
    .then(async (tokens) => {
      // Store tokens in CES
      const accessStored = await setSecureKeyAsync(
        "credential/chatgpt/access_token",
        tokens.accessToken,
      );
      if (!accessStored) {
        log.error("Failed to store ChatGPT access token in CES");
        setFlowState("failed", "Failed to store access token");
        return;
      }

      if (tokens.refreshToken) {
        const refreshStored = await setSecureKeyAsync(
          "credential/chatgpt/refresh_token",
          tokens.refreshToken,
        );
        if (!refreshStored) {
          log.error("Failed to store ChatGPT refresh token in CES");
          setFlowState("failed", "Failed to store refresh token");
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
          setFlowState("failed", "Failed to update connection");
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
          setFlowState("failed", "Failed to create connection");
          return;
        }
      }

      log.info("ChatGPT subscription auth flow completed successfully");
      setFlowState("completed");
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err: message },
        "ChatGPT subscription auth flow failed",
      );
      setFlowState("failed", message);
    });

  return {
    device_code: deviceCodeResult.deviceCode,
    user_code: deviceCodeResult.userCode,
    verification_uri: deviceCodeResult.verificationUri,
    verification_uri_complete: deviceCodeResult.verificationUriComplete,
    expires_in: deviceCodeResult.expiresIn,
    interval: deviceCodeResult.interval,
  };
}

async function handleAuthStatus(_args: RouteHandlerArgs) {
  const result: { status: FlowStatus; error?: string } = {
    status: flowStatus,
  };
  if (flowError) {
    result.error = flowError;
  }

  // Reset to idle after reading a terminal state
  if (flowStatus === "completed" || flowStatus === "failed") {
    setFlowState("idle");
  }

  return result;
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
    summary: "Start ChatGPT subscription OAuth device-code flow",
    description:
      "Initiate a device-code OAuth flow against OpenAI for ChatGPT subscription auth. Returns a verification URI and user code for the client to display. The token polling, exchange, and connection creation happen in the background.",
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
    summary: "Poll ChatGPT subscription OAuth flow status",
    description:
      "Returns the current status of the device-code OAuth flow: idle, pending, completed, or failed. Terminal states (completed/failed) reset to idle after being read.",
    tags: ["inference"],
    responseBody: z.object({
      status: z.enum(["idle", "pending", "completed", "failed"]),
      error: z.string().optional(),
    }),
    handler: handleAuthStatus,
  },
];
