import * as net from "node:net";

import {
  getNestedValue,
  loadConfig,
  loadRawConfig,
} from "../../config/loader.js";
import { getPublicBaseUrl } from "../../inbound/public-ingress-urls.js";
import { orchestrateOAuthConnect } from "../../oauth/connect-orchestrator.js";
import { getSecureKey } from "../../security/secure-keys.js";
import {
  assertMetadataWritable,
  getCredentialMetadata,
  upsertCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import { ConfigError } from "../../util/errors.js";
import type {
  TwitterAuthStartRequest,
  TwitterAuthStatusRequest,
} from "../ipc-protocol.js";
import { defineHandlers, type HandlerContext, log } from "./shared.js";

/** Map raw orchestrator/provider error messages to user-friendly strings. */
function sanitizeTwitterAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("timed out")) {
    return "Twitter authentication timed out. Please try again.";
  }
  if (lower.includes("user_cancelled") || lower.includes("cancelled")) {
    return "Twitter authentication was cancelled.";
  }
  if (lower.includes("denied") || lower.includes("invalid_grant")) {
    return "Twitter denied the authorization request. Please try again.";
  }
  return "Twitter authentication failed. Please try again.";
}

export async function handleTwitterAuthStart(
  _msg: TwitterAuthStartRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    assertMetadataWritable();
  } catch {
    ctx.send(socket, {
      type: "twitter_auth_result",
      success: false,
      error:
        "Credential metadata file has an unrecognized version. Cannot store OAuth credentials.",
    });
    return;
  }

  try {
    const raw = loadRawConfig();
    const mode =
      (getNestedValue(raw, "twitter.integrationMode") as string | undefined) ??
      "local_byo";
    if (mode !== "local_byo") {
      ctx.send(socket, {
        type: "twitter_auth_result",
        success: false,
        error: 'Twitter integration mode must be "local_byo" to use this flow.',
      });
      return;
    }

    const clientId = getSecureKey("credential:integration:twitter:client_id");
    if (!clientId) {
      ctx.send(socket, {
        type: "twitter_auth_result",
        success: false,
        error:
          "No Twitter client credentials configured. Please set up your Client ID first.",
      });
      return;
    }

    const clientSecret =
      getSecureKey("credential:integration:twitter:client_secret") || undefined;

    // Fail fast if no public ingress URL is configured — Twitter OAuth
    // callbacks must route through the gateway, never via loopback.
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      const detail = err instanceof ConfigError ? err.message : String(err);
      ctx.send(socket, {
        type: "twitter_auth_result",
        success: false,
        error: `Unable to load config: ${detail}`,
      });
      return;
    }

    try {
      getPublicBaseUrl(config);
    } catch {
      ctx.send(socket, {
        type: "twitter_auth_result",
        success: false,
        error:
          "Set ingress.publicBaseUrl (or INGRESS_PUBLIC_BASE_URL) so OAuth callbacks can route through /webhooks/oauth/callback on the gateway.",
      });
      return;
    }

    const result = await orchestrateOAuthConnect({
      service: "integration:twitter",
      clientId,
      clientSecret,
      isInteractive: true,
      openUrl: (url: string) => {
        ctx.send(socket, { type: "open_url", url });
      },
      allowedTools: ["twitter_post"],
    });

    if (!result.success) {
      // Use `err` field (covered by logger redaction serializers) rather than
      // `error` to avoid logging potentially secret-bearing strings verbatim.
      log.error(
        { err: result.error },
        "Twitter OAuth orchestrator returned error",
      );
      ctx.send(socket, {
        type: "twitter_auth_result",
        success: false,
        // Safe orchestrator errors are passed through as-is. Errors that may
        // contain raw provider responses are sanitized before surfacing.
        error: result.safeError
          ? result.error
          : sanitizeTwitterAuthError(result.error),
      });
      return;
    }

    if (result.deferred) {
      ctx.send(socket, {
        type: "twitter_auth_result",
        success: false,
        error: `OAuth flow was deferred unexpectedly. Open this URL to authorize: ${result.authUrl}`,
      });
      return;
    }

    // Persist accountInfo to credential metadata so twitter_auth_status
    // can display the @username on subsequent checks.
    if (result.accountInfo) {
      try {
        upsertCredentialMetadata("integration:twitter", "access_token", {
          accountInfo: result.accountInfo,
        });
      } catch {
        // Non-fatal — auth succeeded even if metadata write fails
      }
    }

    ctx.send(socket, {
      type: "twitter_auth_result",
      success: true,
      accountInfo: result.accountInfo,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Twitter OAuth flow failed");

    ctx.send(socket, {
      type: "twitter_auth_result",
      success: false,
      error: sanitizeTwitterAuthError(message),
    });
  }
}

export function handleTwitterAuthStatus(
  _msg: TwitterAuthStatusRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const accessToken = getSecureKey(
      "credential:integration:twitter:access_token",
    );
    const raw = loadRawConfig();
    const mode =
      (getNestedValue(raw, "twitter.integrationMode") as
        | "local_byo"
        | "managed"
        | undefined) ?? "local_byo";
    const meta = getCredentialMetadata("integration:twitter", "access_token");

    ctx.send(socket, {
      type: "twitter_auth_status_response",
      connected: !!accessToken,
      accountInfo: meta?.accountInfo ?? undefined,
      mode,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to get Twitter auth status");
    ctx.send(socket, {
      type: "twitter_auth_status_response",
      connected: false,
      error: message,
    });
  }
}

export const twitterAuthHandlers = defineHandlers({
  twitter_auth_start: handleTwitterAuthStart,
  twitter_auth_status: handleTwitterAuthStatus,
});
