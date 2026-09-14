/**
 * Agent Plugins 1.0.0 `mcp.json` wire schema and projections onto the
 * assistant's in-memory `McpTransport` union.
 *
 * Workspace `/workspace/mcp.json` and each plugin's root `mcp.json` share
 * this document shape. Origin (`workspace` vs `plugin`) is resolved from
 * which file was read, never from a field in the file.
 */

import { z } from "zod";

import type { McpTransport } from "../config/schemas/mcp.js";

/** Canonical `$schema` value for an Agent Plugins 1.0.0 MCP document. */
export const AGENT_PLUGINS_MCP_SCHEMA_URL =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const SpecStdioServerSchema = z.object({
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

/**
 * Remote MCP entry. Agent Plugins 1.0.0 requires `type` and names no
 * default. MCP's current remote transport is Streamable HTTP, so this
 * host fills omitted `type` and the Claude-style `http` alias as
 * `streamable-http`. `sse` stays explicit.
 */
const SpecHttpServerSchema = z.object({
  type: z
    .union([
      z.literal("streamable-http"),
      z.literal("sse"),
      z.literal("http").transform(() => "streamable-http" as const),
    ])
    .default("streamable-http"),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
});

export const SpecMcpServerSchema = z.union([
  SpecStdioServerSchema,
  SpecHttpServerSchema,
]);

export const SpecMcpDocumentSchema = z.object({
  $schema: z.string().optional(),
  mcpServers: z.record(z.string(), z.unknown()),
});

export type SpecMcpServer = z.infer<typeof SpecMcpServerSchema>;
export type SpecMcpDocument = z.infer<typeof SpecMcpDocumentSchema>;

/**
 * Project one spec-shaped entry onto the assistant's transport union. The
 * two vocabularies already agree on type names and required fields, so this
 * is a field copy plus an optional expander for plugin path variables.
 */
export function projectSpecServerToTransport(
  entry: SpecMcpServer,
  expand?: (value: string) => string,
): McpTransport {
  if (entry.type === "stdio") {
    const map = expand ?? ((value: string) => value);
    return {
      type: "stdio",
      command: entry.command,
      args: (entry.args ?? []).map(map),
      ...(entry.env && {
        env: Object.fromEntries(
          Object.entries(entry.env).map(([key, value]) => [key, map(value)]),
        ),
      }),
    };
  }
  return {
    type: entry.type,
    url: entry.url,
    ...(entry.headers && { headers: entry.headers }),
  };
}

/**
 * Project an in-memory transport onto a spec server entry. Headers are
 * omitted: workspace secrets live in the credential store, and a write
 * must not copy them into `mcp.json`.
 */
export function projectTransportToSpecServer(
  transport: McpTransport,
): Record<string, unknown> {
  if (transport.type === "stdio") {
    const entry: Record<string, unknown> = {
      type: "stdio",
      command: transport.command,
    };
    if (transport.args && transport.args.length > 0) {
      entry.args = transport.args;
    }
    if (transport.env) {
      entry.env = transport.env;
    }
    return entry;
  }
  return {
    type: transport.type,
    url: transport.url,
  };
}
