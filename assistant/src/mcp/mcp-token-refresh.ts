/**
 * Single-flight OAuth token refresh for MCP servers.
 *
 * Reuses the persisted refresh_token, client registration, and discovery
 * metadata to obtain fresh tokens via the SDK's `refreshAuthorization` helper,
 * then persists them through the shared token store. Concurrent refreshes for
 * the same server coalesce onto one in-flight promise.
 */

import {
  discoverAuthorizationServerMetadata,
  refreshAuthorization,
  selectResourceURL,
} from "@modelcontextprotocol/sdk/client/auth.js";

import { getLogger } from "../util/logger.js";
import {
  loadMcpTokenEnvelope,
  McpOAuthProvider,
  persistMcpTokens,
} from "./mcp-oauth-provider.js";

const log = getLogger("mcp-token-refresh");

/** Refresh when tokens are within this window of expiry. */
export const REFRESH_SKEW_MS = 60_000;

const inflight = new Map<string, Promise<boolean>>();

/**
 * Whether stored tokens are expired or will expire within `skewMs`. Tokens
 * whose expiry is unknown (`expiresAt` undefined) are treated as not-expiring —
 * the reactive 401 path handles those.
 */
export function isMcpTokenExpiredOrExpiring(
  expiresAt: number | undefined,
  skewMs = REFRESH_SKEW_MS,
): boolean {
  if (expiresAt === undefined) {
    return false;
  }
  return Date.now() >= expiresAt - skewMs;
}

/**
 * Attempt to refresh a server's OAuth tokens. Returns true when fresh tokens
 * were obtained and persisted, false otherwise (no refresh token, missing
 * registration/discovery, or the refresh request failed). Never throws.
 *
 * Refreshes for the same serverId are single-flight: overlapping callers share
 * one in-flight promise so the token endpoint isn't hit concurrently.
 */
export function refreshMcpTokens(
  serverId: string,
  serverUrl: string,
): Promise<boolean> {
  const existing = inflight.get(serverId);
  if (existing) {
    return existing;
  }
  const promise = doRefresh(serverId, serverUrl).finally(() => {
    inflight.delete(serverId);
  });
  inflight.set(serverId, promise);
  return promise;
}

async function doRefresh(
  serverId: string,
  serverUrl: string,
): Promise<boolean> {
  const provider = new McpOAuthProvider(serverId, serverUrl);
  const [envelope, clientInformation, discovery] = await Promise.all([
    loadMcpTokenEnvelope(serverId),
    provider.clientInformation(),
    provider.discoveryState(),
  ]);

  const refreshToken = envelope?.tokens.refresh_token;
  if (!refreshToken) {
    log.info({ serverId }, "No refresh token available — cannot refresh");
    return false;
  }
  if (!clientInformation) {
    log.info({ serverId }, "No client registration available — cannot refresh");
    return false;
  }
  if (!discovery?.authorizationServerUrl) {
    log.info({ serverId }, "No discovery metadata available — cannot refresh");
    return false;
  }

  const authorizationServerUrl = new URL(discovery.authorizationServerUrl);
  let metadata = discovery.authorizationServerMetadata;
  if (!metadata) {
    try {
      metadata = await discoverAuthorizationServerMetadata(
        authorizationServerUrl,
      );
    } catch (err) {
      log.warn(
        { serverId, err: err instanceof Error ? err.message : String(err) },
        "Authorization server metadata discovery failed during refresh",
      );
    }
  }

  let resource: URL | undefined;
  try {
    resource =
      (await selectResourceURL(
        new URL(serverUrl),
        provider,
        discovery.resourceMetadata,
      )) ?? undefined;
  } catch (err) {
    log.warn(
      { serverId, err: err instanceof Error ? err.message : String(err) },
      "Resource URL selection failed during refresh",
    );
    resource = undefined;
  }

  try {
    const newTokens = await refreshAuthorization(authorizationServerUrl, {
      metadata,
      clientInformation,
      refreshToken,
      resource,
    });
    const ok = await persistMcpTokens(serverId, newTokens);
    if (ok) {
      log.info({ serverId }, "OAuth tokens refreshed");
    }
    return ok;
  } catch (err) {
    log.warn(
      { serverId, err: err instanceof Error ? err.message : String(err) },
      "OAuth token refresh failed",
    );
    return false;
  }
}
