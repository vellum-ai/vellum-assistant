import * as net from "node:net";

import {
  getNestedValue,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import {
  deleteSecureKeyAsync,
  getSecureKey,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import {
  deleteCredentialMetadata,
  getCredentialMetadata,
  upsertCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import type {
  TwitterIntegrationConfigRequest,
  VercelApiConfigRequest,
} from "../ipc-protocol.js";
import { defineHandlers, type HandlerContext, log } from "./shared.js";

export async function handleVercelApiConfig(
  msg: VercelApiConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    if (msg.action === "get") {
      const existing = getSecureKey("credential:vercel:api_token");
      ctx.send(socket, {
        type: "vercel_api_config_response",
        hasToken: !!existing,
        success: true,
      });
    } else if (msg.action === "set") {
      if (!msg.apiToken) {
        ctx.send(socket, {
          type: "vercel_api_config_response",
          hasToken: false,
          success: false,
          error: "apiToken is required for set action",
        });
        return;
      }
      const stored = await setSecureKeyAsync(
        "credential:vercel:api_token",
        msg.apiToken,
      );
      if (!stored) {
        ctx.send(socket, {
          type: "vercel_api_config_response",
          hasToken: false,
          success: false,
          error: "Failed to store API token in secure storage",
        });
        return;
      }
      upsertCredentialMetadata("vercel", "api_token", {
        allowedTools: ["publish_page", "unpublish_page"],
      });
      ctx.send(socket, {
        type: "vercel_api_config_response",
        hasToken: true,
        success: true,
      });
    } else {
      const r = await deleteSecureKeyAsync("credential:vercel:api_token");
      if (r === "error") {
        ctx.send(socket, {
          type: "vercel_api_config_response",
          hasToken: !!getSecureKey("credential:vercel:api_token"),
          success: false,
          error: "Failed to delete Vercel API token from secure storage",
        });
        return;
      }
      deleteCredentialMetadata("vercel", "api_token");
      ctx.send(socket, {
        type: "vercel_api_config_response",
        hasToken: false,
        success: true,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to handle Vercel API config");
    ctx.send(socket, {
      type: "vercel_api_config_response",
      hasToken: false,
      success: false,
      error: message,
    });
  }
}

/** Check whether a Twitter client ID has been stored. */
function hasTwitterClientId(): boolean {
  return !!getSecureKey("credential:integration:twitter:client_id");
}

export async function handleTwitterIntegrationConfig(
  msg: TwitterIntegrationConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    if (msg.action === "get") {
      const raw = loadRawConfig();
      const mode =
        ((getNestedValue(raw, "twitter.integrationMode") ??
          raw.twitterIntegrationMode) as "local_byo" | "managed" | undefined) ??
        "local_byo";
      const strategy =
        ((getNestedValue(raw, "twitter.operationStrategy") ??
          raw.twitterOperationStrategy) as
          | "oauth"
          | "browser"
          | "auto"
          | undefined) ?? "auto";
      const strategyConfigured =
        (getNestedValue(raw, "twitter.operationStrategy") ??
          raw.twitterOperationStrategy) !== undefined;
      const localClientConfigured = hasTwitterClientId();
      const connected = !!getSecureKey(
        "credential:integration:twitter:access_token",
      );
      const meta = getCredentialMetadata("integration:twitter", "access_token");
      ctx.send(socket, {
        type: "twitter_integration_config_response",
        success: true,
        mode,
        managedAvailable: false,
        localClientConfigured,
        connected,
        accountInfo: meta?.accountInfo ?? undefined,
        strategy,
        strategyConfigured,
      });
    } else if (msg.action === "get_strategy") {
      const raw = loadRawConfig();
      const strategy =
        ((getNestedValue(raw, "twitter.operationStrategy") ??
          raw.twitterOperationStrategy) as
          | "oauth"
          | "browser"
          | "auto"
          | undefined) ?? "auto";
      const strategyConfigured =
        (getNestedValue(raw, "twitter.operationStrategy") ??
          raw.twitterOperationStrategy) !== undefined;
      ctx.send(socket, {
        type: "twitter_integration_config_response",
        success: true,
        managedAvailable: false,
        localClientConfigured: hasTwitterClientId(),
        connected: !!getSecureKey(
          "credential:integration:twitter:access_token",
        ),
        strategy,
        strategyConfigured,
      });
    } else if (msg.action === "set_strategy") {
      const valid = ["oauth", "browser", "auto"];
      const value = msg.strategy;
      if (!value || !valid.includes(value)) {
        ctx.send(socket, {
          type: "twitter_integration_config_response",
          success: false,
          managedAvailable: false,
          localClientConfigured: false,
          connected: false,
          error: `Invalid strategy value: ${String(value)}. Must be one of: ${valid.join(", ")}`,
        });
        return;
      }
      const raw = loadRawConfig();
      setNestedValue(raw, "twitter.operationStrategy", value);
      // Migrate: remove legacy flat key if present
      delete raw.twitterOperationStrategy;
      saveRawConfig(raw);
      ctx.send(socket, {
        type: "twitter_integration_config_response",
        success: true,
        managedAvailable: false,
        localClientConfigured: hasTwitterClientId(),
        connected: !!getSecureKey(
          "credential:integration:twitter:access_token",
        ),
        strategy: value as "oauth" | "browser" | "auto",
        strategyConfigured: true,
      });
    } else if (msg.action === "set_mode") {
      const raw = loadRawConfig();
      setNestedValue(raw, "twitter.integrationMode", msg.mode ?? "local_byo");
      // Migrate: remove legacy flat key if present
      delete raw.twitterIntegrationMode;
      saveRawConfig(raw);
      ctx.send(socket, {
        type: "twitter_integration_config_response",
        success: true,
        mode: msg.mode ?? "local_byo",
        managedAvailable: false,
        localClientConfigured: hasTwitterClientId(),
        connected: !!getSecureKey(
          "credential:integration:twitter:access_token",
        ),
      });
    } else if (msg.action === "set_local_client") {
      if (!msg.clientId) {
        ctx.send(socket, {
          type: "twitter_integration_config_response",
          success: false,
          managedAvailable: false,
          localClientConfigured: false,
          connected: false,
          error: "clientId is required for set_local_client action",
        });
        return;
      }
      const previousClientId = getSecureKey(
        "credential:integration:twitter:client_id",
      );
      // Write canonical key (async — writes broker + encrypted store)
      const storedId = await setSecureKeyAsync(
        "credential:integration:twitter:client_id",
        msg.clientId,
      );
      if (!storedId) {
        ctx.send(socket, {
          type: "twitter_integration_config_response",
          success: false,
          managedAvailable: false,
          localClientConfigured: false,
          connected: false,
          error: "Failed to store client ID in secure storage",
        });
        return;
      }
      if (msg.clientSecret) {
        // Write canonical key
        const storedSecret = await setSecureKeyAsync(
          "credential:integration:twitter:client_secret",
          msg.clientSecret,
        );
        if (!storedSecret) {
          // Roll back the client ID to its previous value to avoid inconsistent OAuth state
          if (previousClientId) {
            await setSecureKeyAsync(
              "credential:integration:twitter:client_id",
              previousClientId,
            );
          } else {
            await deleteSecureKeyAsync(
              "credential:integration:twitter:client_id",
            );
          }
          ctx.send(socket, {
            type: "twitter_integration_config_response",
            success: false,
            managedAvailable: false,
            localClientConfigured: !!previousClientId,
            connected: false,
            error: "Failed to store client secret in secure storage",
          });
          return;
        }
      } else {
        // Clear any stale secret when updating client without a secret (e.g. switching to PKCE)
        await deleteSecureKeyAsync(
          "credential:integration:twitter:client_secret",
        );
      }
      ctx.send(socket, {
        type: "twitter_integration_config_response",
        success: true,
        managedAvailable: false,
        localClientConfigured: true,
        connected: !!getSecureKey(
          "credential:integration:twitter:access_token",
        ),
      });
    } else if (msg.action === "clear_local_client") {
      // If connected, disconnect first
      const deleteResults: Array<"deleted" | "not-found" | "error"> = [];
      if (getSecureKey("credential:integration:twitter:access_token")) {
        deleteResults.push(
          await deleteSecureKeyAsync(
            "credential:integration:twitter:access_token",
          ),
        );
        deleteResults.push(
          await deleteSecureKeyAsync(
            "credential:integration:twitter:refresh_token",
          ),
        );
      }
      // Remove client credential keys
      deleteResults.push(
        await deleteSecureKeyAsync("credential:integration:twitter:client_id"),
      );
      deleteResults.push(
        await deleteSecureKeyAsync(
          "credential:integration:twitter:client_secret",
        ),
      );
      const hasDeleteError = deleteResults.some((r) => r === "error");
      if (!hasDeleteError) {
        deleteCredentialMetadata("integration:twitter", "access_token");
      }
      ctx.send(socket, {
        type: "twitter_integration_config_response",
        success: !hasDeleteError,
        managedAvailable: false,
        localClientConfigured: hasDeleteError ? hasTwitterClientId() : false,
        connected: hasDeleteError
          ? !!getSecureKey("credential:integration:twitter:access_token")
          : false,
        ...(hasDeleteError
          ? {
              error:
                "Failed to delete some Twitter credentials from secure storage",
            }
          : {}),
      });
    } else if (msg.action === "disconnect") {
      const dr1 = await deleteSecureKeyAsync(
        "credential:integration:twitter:access_token",
      );
      const dr2 = await deleteSecureKeyAsync(
        "credential:integration:twitter:refresh_token",
      );
      // Client credentials (client_id, client_secret) are intentionally
      // preserved so the user can re-connect without reconfiguring.
      const disconnectFailed = dr1 === "error" || dr2 === "error";
      if (!disconnectFailed) {
        deleteCredentialMetadata("integration:twitter", "access_token");
      }
      ctx.send(socket, {
        type: "twitter_integration_config_response",
        success: !disconnectFailed,
        managedAvailable: false,
        localClientConfigured: hasTwitterClientId(),
        connected: disconnectFailed
          ? !!getSecureKey("credential:integration:twitter:access_token")
          : false,
        ...(disconnectFailed
          ? {
              error: "Failed to delete Twitter tokens from secure storage",
            }
          : {}),
      });
    } else {
      ctx.send(socket, {
        type: "twitter_integration_config_response",
        success: false,
        managedAvailable: false,
        localClientConfigured: false,
        connected: false,
        error: `Unknown action: ${String(msg.action)}`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to handle Twitter integration config");
    ctx.send(socket, {
      type: "twitter_integration_config_response",
      success: false,
      managedAvailable: false,
      localClientConfigured: false,
      connected: false,
      error: message,
    });
  }
}

export const integrationHandlers = defineHandlers({
  vercel_api_config: handleVercelApiConfig,
  twitter_integration_config: handleTwitterIntegrationConfig,
});
