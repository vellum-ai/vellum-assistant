import { createHash } from "node:crypto";

import type {
  McpTransport,
  ResolvedMcpServerConfig,
} from "../config/schemas/mcp.js";

export const MCP_OAUTH_CREDENTIAL_LEAVES = [
  "tokens",
  "client_info",
  "client_binding",
  "discovery",
] as const;

export type McpOAuthCredentialLeaf =
  (typeof MCP_OAUTH_CREDENTIAL_LEAVES)[number];

export type McpOAuthCredentialTarget =
  | {
      readonly source: "workspace";
      readonly serverId: string;
    }
  | {
      readonly source: "plugin";
      readonly pluginName: string;
      readonly serverKey: string;
      readonly transportType: "sse" | "streamable-http";
      readonly url: string;
    };

export function workspaceMcpOAuthCredentialTarget(
  serverId: string,
): McpOAuthCredentialTarget {
  return { source: "workspace", serverId };
}

export function resolveMcpOAuthCredentialTarget(
  serverId: string,
  config: ResolvedMcpServerConfig,
): McpOAuthCredentialTarget | null {
  const transport = config.transport;
  if (transport.type === "stdio") {
    return null;
  }
  if (config.source === "workspace") {
    return workspaceMcpOAuthCredentialTarget(serverId);
  }
  return pluginMcpOAuthCredentialTarget(
    config.pluginName,
    config.serverKey,
    transport,
  );
}

export function pluginMcpOAuthCredentialTarget(
  pluginName: string,
  serverKey: string,
  transport: Extract<McpTransport, { type: "sse" | "streamable-http" }>,
): McpOAuthCredentialTarget {
  return {
    source: "plugin",
    pluginName,
    serverKey,
    transportType: transport.type,
    url: transport.url,
  };
}

export function mcpOAuthCredentialKey(
  target: McpOAuthCredentialTarget,
  leaf: McpOAuthCredentialLeaf,
): string {
  if (target.source === "workspace") {
    return `mcp:${target.serverId}:${leaf}`;
  }
  return `${pluginMcpOAuthCredentialPrefix(target.pluginName, target.serverKey, target.transportType, target.url)}${leaf}`;
}

export function pluginMcpOAuthCredentialPrefix(
  pluginName: string,
  serverKey?: string,
  transportType?: "sse" | "streamable-http",
  rawUrl?: string,
): string {
  const pluginPrefix = `mcp-plugin/v1/${encodeSegment(pluginName)}/`;
  if (serverKey === undefined) {
    return pluginPrefix;
  }
  if (transportType === undefined || rawUrl === undefined) {
    throw new Error("Plugin MCP credential endpoint is incomplete");
  }
  const endpoint = `${transportType}\n${canonicalUrlWithoutFragment(rawUrl)}`;
  const endpointDigest = createHash("sha256").update(endpoint).digest("hex");
  return `${pluginPrefix}${encodeSegment(serverKey)}/${endpointDigest}/`;
}

function encodeSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function canonicalUrlWithoutFragment(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  return url.toString();
}
