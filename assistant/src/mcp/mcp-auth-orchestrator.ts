/**
 * Daemon-side orchestrator for MCP OAuth flows.
 *
 * Runs the entire OAuth exchange (callback registration, auth URL capture,
 * code exchange, token persistence) inside the daemon heap so that
 * registerPendingCallback and consumeCallback always execute in the same
 * process.  The CLI receives only the authorization URL via IPC and polls
 * for completion.
 */

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { getIsContainerized } from "../config/env-registry.js";
import { reloadMcpServers } from "../daemon/mcp-reload-service.js";
import { getLogger } from "../util/logger.js";
import {
  setMcpAuthComplete,
  setMcpAuthError,
  setMcpAuthPending,
} from "./mcp-auth-state.js";
import {
  type McpOAuthCallbackTransport,
  McpOAuthProvider,
} from "./mcp-oauth-provider.js";

const log = getLogger("mcp-auth-orchestrator");

export interface McpAuthTransportConfig {
  url: string;
  type: "sse" | "streamable-http";
  headers?: Record<string, string>;
}

export interface OrchestrateMcpOAuthConnectResult {
  auth_url: string;
  already_authenticated?: true;
}

/**
 * Start a daemon-owned MCP OAuth flow.
 *
 * Returns immediately with the authorization URL for the CLI to open in
 * the browser.  The token exchange runs in the background in the daemon heap
 * and updates the in-memory auth state map on completion.
 */
export async function orchestrateMcpOAuthConnect(args: {
  serverId: string;
  transport: McpAuthTransportConfig;
}): Promise<OrchestrateMcpOAuthConnectResult> {
  const { serverId, transport } = args;

  // Containerized deployments (platform-managed AND self-hosted Docker) must
  // use the gateway transport: the browser is outside the daemon container,
  // so a loopback callback inside the container is unreachable. Bare-metal
  // daemons can use loopback as before.
  const callbackTransport: McpOAuthCallbackTransport = getIsContainerized()
    ? "gateway"
    : "loopback";

  let capturedAuthUrl: string | undefined;
  const provider = new McpOAuthProvider(
    serverId,
    transport.url,
    /* interactive */ false,
    callbackTransport,
    {
      onAuthorizationUrl: (url) => {
        capturedAuthUrl = url;
      },
    },
  );

  // Clear stale credentials so the flow starts fresh
  await provider.invalidateCredentials("client");
  await provider.invalidateCredentials("discovery");

  // Register the pending callback in the daemon heap
  const { codePromise } = await provider.startCallbackServer();

  // Build the MCP transport and client
  const serverUrl = new URL(transport.url);
  const TransportClass =
    transport.type === "sse"
      ? SSEClientTransport
      : StreamableHTTPClientTransport;
  const mcpTransport = new TransportClass(serverUrl, {
    authProvider: provider,
    requestInit: transport.headers ? { headers: transport.headers } : undefined,
  });
  const client = new Client({ name: "vellum-assistant", version: "1.0.0" });

  try {
    await client.connect(mcpTransport);
    // No error — server is already authenticated
    provider.stopCallbackServer();
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    return { auth_url: "", already_authenticated: true };
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      // Expected — onAuthorizationUrl has fired, capturedAuthUrl is set
    } else {
      provider.stopCallbackServer();
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  if (!capturedAuthUrl) {
    provider.stopCallbackServer();
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    throw new Error("No authorization URL captured from OAuth provider");
  }

  // Per-attempt token. Gates fire-and-forget state writes so that a
  // re-run of `assistant mcp auth <serverId>` before the previous attempt
  // finishes cannot have its slot overwritten by stale completion writes
  // from the older attempt.
  const attemptId = crypto.randomUUID();
  setMcpAuthPending(serverId, capturedAuthUrl, attemptId);

  // Fire-and-forget background tail — completes the token exchange once
  // the user approves in the browser.
  // Note: we do NOT call client.connect() again here — both SSEClientTransport
  // and StreamableHTTPClientTransport throw "already started" on a second
  // connect() call.  The tokens are persisted by saveTokens inside finishAuth,
  // so the daemon can reconnect on the next MCP reload without re-connecting here.
  void (async () => {
    try {
      // Apply an explicit timeout: the loopback callback path has a built-in
      // 2-minute timer, but the gateway transport's deferred promise relies on
      // the caller for time-boxing. Without this race, gateway-mode tails leak
      // forever if the user never completes the OAuth handshake.
      const code = await Promise.race([
        codePromise,
        new Promise<never>((_, reject) => {
          const t = setTimeout(
            () => reject(new Error("OAuth callback timed out")),
            CALLBACK_TIMEOUT_MS,
          );
          // Don't keep the event loop alive solely for this timer
          if (typeof t.unref === "function") t.unref();
        }),
      ]);
      await mcpTransport.finishAuth(code);
      const applied = setMcpAuthComplete(serverId, attemptId);
      if (!applied) {
        log.info(
          { serverId, attemptId },
          "MCP OAuth completion superseded by newer attempt — skipping state write",
        );
        return;
      }
      log.info({ serverId }, "MCP OAuth flow completed");
      // Trigger MCP reload from inside the daemon so the CLI doesn't need
      // to fall back on the deprecated file-based signal mechanism.
      // Best-effort: reload failures are logged but don't poison the
      // success status the polling CLI is about to observe.
      try {
        await reloadMcpServers();
      } catch (reloadErr) {
        log.warn(
          {
            serverId,
            err:
              reloadErr instanceof Error
                ? reloadErr.message
                : String(reloadErr),
          },
          "MCP reload after auth completion failed",
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const applied = setMcpAuthError(serverId, message, attemptId);
      if (!applied) {
        log.info(
          { serverId, attemptId, error: message },
          "MCP OAuth error superseded by newer attempt — skipping state write",
        );
      } else {
        log.warn({ serverId, error: message }, "MCP OAuth flow failed");
      }
    } finally {
      provider.stopCallbackServer();
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
  })();

  return { auth_url: capturedAuthUrl };
}

// Matches the loopback callback timeout; keep both in lockstep so loopback
// and gateway transports time-box OAuth identically.
const CALLBACK_TIMEOUT_MS = 2 * 60 * 1000;
