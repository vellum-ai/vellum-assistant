import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { getIsPlatform } from "../config/env-registry.js";
import type { McpTransport } from "../config/schemas/mcp.js";
import { getLogger } from "../util/logger.js";
import { getMcpHeaders } from "./mcp-header-store.js";
import {
  loadMcpTokenEnvelope,
  McpOAuthProvider,
} from "./mcp-oauth-provider.js";
import {
  isMcpTokenExpiredOrExpiring,
  refreshMcpTokens,
} from "./mcp-token-refresh.js";

const log = getLogger("mcp-client");

const CONNECT_TIMEOUT_MS = 30_000;

// MCP servers occasionally return tools with a missing or non-object
// `inputSchema` (spec violation, but seen in the wild). Coerce to a valid
// empty object schema so downstream code that assumes `input_schema: object`
// (e.g. `injectActivityField`) doesn't crash.
function normalizeInputSchema(
  raw: unknown,
  toolName: string,
): Record<string, unknown> {
  if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  log.warn(
    { toolName, received: typeof raw },
    "MCP tool returned non-object inputSchema; defaulting to empty object schema",
  );
  return { type: "object", properties: {} };
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content: string;
  isError: boolean;
}

export class McpClient {
  readonly serverId: string;
  private client: Client;
  private transport:
    | StdioClientTransport
    | SSEClientTransport
    | StreamableHTTPClientTransport
    | null = null;
  private connected = false;
  private oauthProvider: McpOAuthProvider | null = null;
  private _lastError: Error | null = null;

  /** The last connection error, if any. Null when connected or not yet attempted. */
  get lastError(): Error | null {
    return this._lastError;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  constructor(serverId: string) {
    this.serverId = serverId;
    this.client = new Client({
      name: "vellum-assistant",
      version: "1.0.0",
    });

    // Prevent SDK-internal transport errors (e.g. SSE reconnection auth
    // failures) from surfacing as unhandled rejections that crash the daemon
    // via the global unhandledRejection → shutdown handler.
    this.client.onerror = (error) => {
      log.warn(
        { serverId: this.serverId, err: error },
        "MCP SDK transport error (non-fatal)",
      );
    };
  }

  async connect(transportConfig: McpTransport): Promise<void> {
    if (this.connected) return;

    const isHttpTransport =
      transportConfig.type === "sse" ||
      transportConfig.type === "streamable-http";
    const serverUrl =
      transportConfig.type === "stdio" ? undefined : transportConfig.url;

    // For HTTP transports, only attach an OAuth provider if cached tokens exist.
    // This avoids triggering client registration (which binds to a random port)
    // during daemon startup. If no tokens, try without auth — if the server
    // requires it, skip silently.
    if (isHttpTransport && serverUrl) {
      const envelope = await loadMcpTokenEnvelope(this.serverId);
      if (envelope) {
        const callbackTransport = getIsPlatform() ? "gateway" : "loopback";
        this.oauthProvider = new McpOAuthProvider(
          this.serverId,
          serverUrl,
          callbackTransport,
        );
        // Re-hydrate the redirect URI bound to this server's registration so a
        // mid-session 401 reaches the SDK's token-refresh branch rather than
        // its non-interactive dead end.
        await this.oauthProvider.hydratePersistedRedirectUri();
        // Proactively refresh tokens that are expired or near expiry so the
        // first request doesn't fail and force a reconnect.
        if (isMcpTokenExpiredOrExpiring(envelope.expiresAt)) {
          await refreshMcpTokens(this.serverId, serverUrl).catch(() => false);
        }
      }
    }

    // Resolve static auth headers from credential store, falling back to
    // any legacy headers in the transport config for backward compatibility.
    let effectiveConfig = transportConfig;
    if (isHttpTransport) {
      const storedHeaders = await getMcpHeaders(this.serverId);
      if (storedHeaders) {
        effectiveConfig = {
          ...transportConfig,
          headers: { ...transportConfig.headers, ...storedHeaders },
        } as McpTransport;
      }
    }

    log.info({ serverId: this.serverId }, "Connecting to MCP server");

    const firstError = await this.attemptConnect(effectiveConfig);
    if (!firstError) {
      this.connected = true;
      log.info({ serverId: this.serverId }, "MCP client connected");
      return;
    }

    if (isHttpTransport && isAuthRelatedError(firstError)) {
      // Reactive refresh: obtain fresh tokens once, then reconnect once.
      const refreshed =
        this.oauthProvider && serverUrl
          ? await refreshMcpTokens(this.serverId, serverUrl).catch(() => false)
          : false;
      if (refreshed) {
        const retryError = await this.attemptConnect(effectiveConfig);
        if (!retryError) {
          this.connected = true;
          log.info(
            { serverId: this.serverId },
            "MCP client connected after token refresh",
          );
          return;
        }
        if (isAuthRelatedError(retryError)) {
          // Refresh did not restore access — user can run
          // `assistant mcp auth <name>` to re-authenticate.
          log.info(
            { serverId: this.serverId, err: retryError },
            "MCP server requires authentication",
          );
          return;
        }
        this._lastError = retryError;
        log.error(
          { serverId: this.serverId, err: retryError },
          "MCP server connection failed",
        );
        return;
      }

      // No refresh available — user can run `assistant mcp auth <name>`.
      log.info(
        { serverId: this.serverId, err: firstError },
        "MCP server requires authentication",
      );
      return;
    }

    // Non-auth error (DNS, TLS, timeout, etc.) — log but never propagate
    // an MCP connection failure to the caller.  The daemon must keep
    // running even when individual MCP servers are unreachable.
    this._lastError = firstError;
    log.error(
      { serverId: this.serverId, err: firstError },
      "MCP server connection failed",
    );
  }

  /**
   * Run a single connection attempt with a fresh transport, returning the
   * error on failure (after closing the client) or null on success. A fresh
   * transport per attempt avoids the "already started" error SSE and
   * StreamableHTTP transports throw when reconnected.
   */
  private async attemptConnect(config: McpTransport): Promise<Error | null> {
    this.transport = this.createTransport(config);
    try {
      await Promise.race([
        this.client.connect(this.transport),
        new Promise<never>((_, reject) => {
          const t = setTimeout(
            () =>
              reject(
                new Error(
                  `MCP server "${this.serverId}" connection timed out after ${CONNECT_TIMEOUT_MS}ms`,
                ),
              ),
            CONNECT_TIMEOUT_MS,
          );
          if (typeof t === "object" && "unref" in t) {
            t.unref();
          }
        }),
      ]);
      return null;
    } catch (err) {
      try {
        await this.client.close();
      } catch {
        /* ignore cleanup errors */
      }
      this.transport = null;
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (!this.connected) {
      throw new Error(`MCP client "${this.serverId}" is not connected`);
    }

    const result = await Promise.race([
      this.client.listTools(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `MCP server "${this.serverId}" listTools timed out after ${CONNECT_TIMEOUT_MS}ms`,
              ),
            ),
          CONNECT_TIMEOUT_MS,
        ),
      ),
    ]);
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: normalizeInputSchema(tool.inputSchema, tool.name),
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    if (!this.connected) {
      throw new Error(`MCP client "${this.serverId}" is not connected`);
    }

    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      signal ? { signal } : undefined,
    );
    const isError = result.isError === true;

    // Handle structuredContent if present
    if (result.structuredContent !== undefined) {
      return {
        content: JSON.stringify(result.structuredContent),
        isError,
      };
    }

    // Concatenate all content blocks into a single string
    const textParts: string[] = [];
    if (Array.isArray(result.content)) {
      for (const block of result.content) {
        if (
          typeof block === "object" &&
          block !== undefined &&
          "type" in block
        ) {
          if (block.type === "text" && "text" in block) {
            textParts.push(String(block.text));
          } else if (block.type === "resource" && "resource" in block) {
            const resource = block.resource as Record<string, unknown>;
            textParts.push(
              typeof resource.text === "string"
                ? resource.text
                : JSON.stringify(resource),
            );
          } else {
            // For other content types (image, etc.), include type and any available data
            textParts.push(`[${block.type} content: ${JSON.stringify(block)}]`);
          }
        }
      }
    }

    return {
      content:
        textParts.join("\n") ||
        (isError ? "Tool execution failed" : "Tool executed successfully"),
      isError,
    };
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;

    try {
      await this.client.close();
    } catch (err) {
      log.warn({ err, serverId: this.serverId }, "Error closing MCP client");
    }
    this.connected = false;
    this.transport = null;
    log.info({ serverId: this.serverId }, "MCP client disconnected");
  }

  private createTransport(
    config: McpTransport,
  ): StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport {
    switch (config.type) {
      case "stdio":
        return new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env
            ? ({ ...process.env, ...config.env } as Record<string, string>)
            : undefined,
        });
      case "sse":
        return new SSEClientTransport(new URL(config.url), {
          authProvider: this.oauthProvider ?? undefined,
          requestInit: config.headers ? { headers: config.headers } : undefined,
        });
      case "streamable-http":
        return new StreamableHTTPClientTransport(new URL(config.url), {
          authProvider: this.oauthProvider ?? undefined,
          requestInit: config.headers ? { headers: config.headers } : undefined,
        });
    }
  }
}

/**
 * Returns true when `err` looks like an authentication / authorization failure
 * from the MCP SDK or the remote server.  Used to distinguish "needs auth"
 * from genuine transport failures so we can log guidance instead of crashing.
 */
export function isAuthRelatedError(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;

  if (
    err instanceof Error &&
    /\b(401|403|unauthorized|forbidden|authorizationCode is required|prepareTokenRequest)\b/i.test(
      err.message,
    )
  ) {
    return true;
  }

  if (
    err != null &&
    typeof err === "object" &&
    "code" in err &&
    (err.code === 401 || err.code === 403)
  ) {
    return true;
  }

  return false;
}
