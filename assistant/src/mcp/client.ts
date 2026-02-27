import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { McpTransport } from '../config/mcp-schema.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('mcp-client');

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
  private transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport | null = null;
  private connected = false;

  constructor(serverId: string) {
    this.serverId = serverId;
    this.client = new Client({
      name: 'vellum-assistant',
      version: '1.0.0',
    });
  }

  async connect(transportConfig: McpTransport): Promise<void> {
    if (this.connected) return;

    console.log(`[MCP] Connecting to server "${this.serverId}"...`);
    this.transport = this.createTransport(transportConfig);
    await Promise.race([
      this.client.connect(this.transport),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`MCP server "${this.serverId}" connection timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS),
      ),
    ]);
    this.connected = true;
    console.log(`[MCP] Server "${this.serverId}" connected successfully`);
    log.info({ serverId: this.serverId }, 'MCP client connected');
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (!this.connected) {
      throw new Error(`MCP client "${this.serverId}" is not connected`);
    }

    const result = await Promise.race([
      this.client.listTools(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`MCP server "${this.serverId}" listTools timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS),
      ),
    ]);
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!this.connected) {
      throw new Error(`MCP client "${this.serverId}" is not connected`);
    }

    const result = await this.client.callTool({ name, arguments: args });
    const isError = result.isError === true;

    // Concatenate all text content blocks into a single string
    const textParts: string[] = [];
    if (Array.isArray(result.content)) {
      for (const block of result.content) {
        if (typeof block === 'object' && block !== null && 'type' in block) {
          if (block.type === 'text' && 'text' in block) {
            textParts.push(String(block.text));
          } else {
            // For non-text content, include a description
            textParts.push(`[${block.type} content]`);
          }
        }
      }
    }

    return {
      content: textParts.join('\n') || (isError ? 'Tool execution failed' : 'Tool executed successfully'),
      isError,
    };
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;

    try {
      await this.client.close();
    } catch (err) {
      log.warn({ err, serverId: this.serverId }, 'Error closing MCP client');
    }
    this.connected = false;
    this.transport = null;
    log.info({ serverId: this.serverId }, 'MCP client disconnected');
  }

  private createTransport(config: McpTransport): StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport {
    switch (config.type) {
      case 'stdio':
        return new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
        });
      case 'sse':
        return new SSEClientTransport(
          new URL(config.url),
          { requestInit: config.headers ? { headers: config.headers } : undefined },
        );
      case 'streamable-http':
        return new StreamableHTTPClientTransport(
          new URL(config.url),
          { requestInit: config.headers ? { headers: config.headers } : undefined },
        );
    }
  }
}
