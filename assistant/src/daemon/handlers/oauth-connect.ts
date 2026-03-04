import * as net from "node:net";

import { orchestrateOAuthConnect } from "../../oauth/connect-orchestrator.js";
import {
  getProviderProfile,
  resolveService,
} from "../../oauth/provider-profiles.js";
import { getSecureKey } from "../../security/secure-keys.js";
import {
  assertMetadataWritable,
  getCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import type { OAuthConnectStartRequest } from "../ipc-protocol.js";
import { defineHandlers, type HandlerContext, log } from "./shared.js";

/** Map raw orchestrator/provider error messages to user-friendly strings. */
function sanitizeOAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("timed out")) {
    return "OAuth authentication timed out. Please try again.";
  }
  if (lower.includes("user_cancelled") || lower.includes("cancelled")) {
    return "OAuth authentication was cancelled.";
  }
  if (lower.includes("denied") || lower.includes("invalid_grant")) {
    return "The authorization request was denied. Please try again.";
  }
  return "OAuth authentication failed. Please try again.";
}

export async function handleOAuthConnectStart(
  msg: OAuthConnectStartRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    assertMetadataWritable();
  } catch {
    ctx.send(socket, {
      type: "oauth_connect_result",
      success: false,
      error:
        "Credential metadata file has an unrecognized version. Cannot store OAuth credentials.",
    });
    return;
  }

  try {
    if (!msg.service) {
      ctx.send(socket, {
        type: "oauth_connect_result",
        success: false,
        error: "Missing required field: service",
      });
      return;
    }

    const resolvedService = resolveService(msg.service);

    // Look up client credentials from the keychain under the canonical
    // service name first, then fall back to the original (alias) name
    // in case the user stored credentials under the unresolved key.
    let clientId =
      getSecureKey(`credential:${resolvedService}:client_id`) ??
      getSecureKey(`credential:${resolvedService}:oauth_client_id`);

    if (!clientId && resolvedService !== msg.service) {
      clientId =
        getSecureKey(`credential:${msg.service}:client_id`) ??
        getSecureKey(`credential:${msg.service}:oauth_client_id`);
    }

    // Fall back to credential metadata for legacy installs where client
    // credentials were stored only in metadata (not in the keychain).
    // Check both canonical and alias service keys, matching the keychain
    // lookup pattern above.
    if (!clientId) {
      const meta = getCredentialMetadata(resolvedService, "access_token");
      if (meta?.oauth2ClientId) {
        clientId = meta.oauth2ClientId;
      } else if (resolvedService !== msg.service) {
        const aliasMeta = getCredentialMetadata(msg.service, "access_token");
        if (aliasMeta?.oauth2ClientId) {
          clientId = aliasMeta.oauth2ClientId;
        }
      }
    }

    if (!clientId) {
      ctx.send(socket, {
        type: "oauth_connect_result",
        success: false,
        error: `No client_id found for "${msg.service}". Store it first via the credential vault.`,
      });
      return;
    }

    let clientSecret =
      getSecureKey(`credential:${resolvedService}:client_secret`) ??
      getSecureKey(`credential:${resolvedService}:oauth_client_secret`) ??
      undefined;

    if (!clientSecret && resolvedService !== msg.service) {
      clientSecret =
        getSecureKey(`credential:${msg.service}:client_secret`) ??
        getSecureKey(`credential:${msg.service}:oauth_client_secret`) ??
        undefined;
    }

    // Fall back to credential metadata for legacy installs — check both
    // canonical and alias service keys, matching the keychain lookup pattern.
    if (!clientSecret) {
      const meta = getCredentialMetadata(resolvedService, "access_token");
      if (meta?.oauth2ClientSecret) {
        clientSecret = meta.oauth2ClientSecret;
      } else if (resolvedService !== msg.service) {
        const aliasMeta = getCredentialMetadata(msg.service, "access_token");
        if (aliasMeta?.oauth2ClientSecret) {
          clientSecret = aliasMeta.oauth2ClientSecret;
        }
      }
    }

    // Fail early when client_secret is required but missing — guide the
    // user to collect it from the keychain rather than letting the OAuth
    // flow proceed and fail at token exchange.
    const profile = getProviderProfile(resolvedService);
    const requiresSecret =
      profile?.setup?.requiresClientSecret ??
      !!(profile?.tokenEndpointAuthMethod || profile?.extraParams);
    if (requiresSecret && !clientSecret) {
      ctx.send(socket, {
        type: "oauth_connect_result",
        success: false,
        error: `client_secret is required for "${msg.service}" but not found in the keychain. Store it first via the credential vault.`,
      });
      return;
    }

    const result = await orchestrateOAuthConnect({
      service: msg.service,
      requestedScopes: msg.requestedScopes,
      clientId,
      clientSecret,
      isInteractive: true,
      openUrl: (url: string) => {
        ctx.send(socket, { type: "open_url", url });
      },
    });

    if (!result.success) {
      // Use `err` field (covered by logger redaction serializers) rather than
      // `error` to avoid logging potentially secret-bearing strings verbatim.
      log.error(
        { err: result.error, service: msg.service },
        "OAuth connect orchestrator returned error",
      );
      ctx.send(socket, {
        type: "oauth_connect_result",
        success: false,
        // Safe orchestrator errors (scope violations, missing config, etc.) are
        // passed through as-is. Errors that may contain raw provider responses
        // are sanitized before surfacing to the user.
        error: result.safeError
          ? result.error
          : sanitizeOAuthError(result.error),
      });
      return;
    }

    if (result.deferred) {
      // Deferred flows should not happen for interactive daemon connections,
      // but handle gracefully by returning the auth URL as an error hint.
      ctx.send(socket, {
        type: "oauth_connect_result",
        success: false,
        error: `OAuth flow was deferred. Open this URL to authorize: ${result.authUrl}`,
      });
      return;
    }

    ctx.send(socket, {
      type: "oauth_connect_result",
      success: true,
      grantedScopes: result.grantedScopes,
      accountInfo: result.accountInfo,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, service: msg.service }, "OAuth connect flow failed");

    ctx.send(socket, {
      type: "oauth_connect_result",
      success: false,
      error: sanitizeOAuthError(message),
    });
  }
}

export const oauthConnectHandlers = defineHandlers({
  oauth_connect_start: handleOAuthConnectStart,
});
