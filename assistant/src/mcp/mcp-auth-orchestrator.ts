import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { reloadMcpServers } from "../daemon/mcp-reload-service.js";
import { getLogger } from "../util/logger.js";
import { beginMcpConnection } from "./connection-lifecycle.js";
import {
  cancelCurrentMcpAuth,
  clearMcpAuthCancellation,
  registerMcpAuthCancellation,
  setMcpAuthComplete,
  setMcpAuthError,
  setMcpAuthPending,
} from "./mcp-auth-state.js";
import { getMcpHeaders } from "./mcp-header-store.js";
import { McpOAuthProvider } from "./mcp-oauth-provider.js";

const log = getLogger("mcp-auth-orchestrator");
const CALLBACK_TIMEOUT_MS = 2 * 60 * 1000;

export interface McpAuthTransportConfig {
  url: string;
  type: "sse" | "streamable-http";
  headers?: Record<string, string>;
}

export interface OrchestrateMcpOAuthConnectResult {
  auth_url: string;
  attempt_id: string;
  already_authenticated?: true;
}

/** The route holds the server operation lock while preparing authorization. */
export async function orchestrateMcpOAuthConnect(args: {
  serverId: string;
  transport: McpAuthTransportConfig;
}): Promise<OrchestrateMcpOAuthConnectResult> {
  const { serverId, transport } = args;
  cancelCurrentMcpAuth(serverId);
  await beginMcpConnection(serverId);
  const attemptId = crypto.randomUUID();
  setMcpAuthPending(serverId, "", attemptId);

  let capturedAuthUrl: string | undefined;
  const provider = new McpOAuthProvider(serverId, transport.url, false, {
    requireConfigured: true,
    onAuthorizationUrl: (url) => {
      capturedAuthUrl = url;
    },
  });
  const client = new Client({ name: "vellum-assistant", version: "1.0.0" });
  registerMcpAuthCancellation(serverId, attemptId, () => provider.close());

  const close = async (): Promise<void> => {
    clearMcpAuthCancellation(serverId, attemptId);
    provider.close();
    try {
      await client.close();
    } catch (err) {
      log.debug({ err, serverId }, "MCP OAuth transport close failed");
    }
  };

  try {
    // Discovery is refreshed while a valid client registration is retained.
    await provider.invalidateCredentials("discovery");
    const { codePromise } = await provider.startCallbackServer();
    const storedHeaders = await getMcpHeaders(serverId);
    const effectiveHeaders = storedHeaders ?? transport.headers;
    const TransportClass =
      transport.type === "sse"
        ? SSEClientTransport
        : StreamableHTTPClientTransport;
    const mcpTransport = new TransportClass(new URL(transport.url), {
      authProvider: provider,
      requestInit: effectiveHeaders ? { headers: effectiveHeaders } : undefined,
    });
    try {
      await client.connect(mcpTransport);
      setMcpAuthComplete(serverId, attemptId);
      await close();
      await reloadMcpServers();
      return {
        auth_url: "",
        attempt_id: attemptId,
        already_authenticated: true,
      };
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) {
        throw err;
      }
    }
    if (!capturedAuthUrl) {
      throw new Error("No authorization URL captured from OAuth provider");
    }
    setMcpAuthPending(serverId, capturedAuthUrl, attemptId);

    void (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const code = await Promise.race([
          codePromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("OAuth callback timed out")),
              CALLBACK_TIMEOUT_MS,
            );
            timer.unref();
          }),
        ]);
        // Credential persistence itself checks the provider's generation.
        await mcpTransport.finishAuth(code);
        if (!setMcpAuthComplete(serverId, attemptId)) {
          return;
        }
        try {
          const reload = await reloadMcpServers();
          if (!reload.success) {
            throw new Error(reload.error);
          }
        } catch (err) {
          log.warn({ serverId, err }, "MCP reload after authorization failed");
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (setMcpAuthError(serverId, error, attemptId)) {
          log.warn({ serverId, error }, "MCP OAuth flow failed");
        }
      } finally {
        clearTimeout(timer);
        await close();
      }
    })();
    return { auth_url: capturedAuthUrl, attempt_id: attemptId };
  } catch (err) {
    setMcpAuthError(
      serverId,
      err instanceof Error ? err.message : String(err),
      attemptId,
    );
    await close();
    throw err;
  }
}
