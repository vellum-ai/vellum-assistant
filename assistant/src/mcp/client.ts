import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { McpTransport } from "../config/schemas/mcp.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import { McpOAuthProvider } from "./mcp-oauth-provider.js";

const log = getLogger("mcp-client");

const CONNECT_TIMEOUT_MS = 30_000;

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

  get isConnected(): boolean {
    return this.connected;
  }

  constructor(serverId: string) {
    this.serverId = serverId;
    this.client = new Client({
      name: "vellum-assistant",
      version: "1.0.0",
    });
  }

  async connect(transportConfig: McpTransport): Promise<void> {
    if (this.connected) return;

    const isHttpTransport =
      transportConfig.type === "sse" ||
      transportConfig.type === "streamable-http";

    // For HTTP transports, only attach an OAuth provider if cached tokens exist.
    // This avoids triggering client registration (which binds to a random port)
    // during daemon startup. If no tokens, try without auth — if the server
    // requires it, skip silently.
    if (isHttpTransport) {
      const cachedTokens = await getSecureKeyAsync(
        `mcp:${this.serverId}:tokens`,
      );
      if (cachedTokens) {
        this.oauthProvider = new McpOAuthProvider(
          this.serverId,
          transportConfig.url,
        );
      }
    }

    log.info({ serverId: this.serverId }, "Connecting to MCP server");
    this.transport = this.createTransport(transportConfig);

    try {
      await Promise.race([
        this.client.connect(this.transport),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `MCP server "${this.serverId}" connection timed out after ${CONNECT_TIMEOUT_MS}ms`,
                ),
              ),
            CONNECT_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (err) {
      try {
        await this.client.close();
      } catch {
        /* ignore cleanup errors */
      }
      this.transport = null;

      if (isHttpTransport) {
        const isAuthError =
          err instanceof UnauthorizedError ||
          (err instanceof Error &&
            /\b(401|403|unauthorized|forbidden)\b/i.test(err.message)) ||
          (err != null &&
            typeof err === "object" &&
            "code" in err &&
            (err.code === 401 || err.code === 403));

        if (isAuthError) {
          // Auth-related — user can run `assistant mcp auth <name>` to authenticate.
          log.info(
            { serverId: this.serverId, err },
            "MCP server requires authentication",
          );
          return;
        }

        // Non-auth error (DNS, TLS, timeout, etc.) — log and re-throw
        log.error(
          { serverId: this.serverId, err },
          "MCP server connection failed",
        );
        throw err;
      }

      throw err;
    }

    this.connected = true;
    log.info({ serverId: this.serverId }, "MCP client connected");
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
      inputSchema: tool.inputSchema as Record<string, unknown>,
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
