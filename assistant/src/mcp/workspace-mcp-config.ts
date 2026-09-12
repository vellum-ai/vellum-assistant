/**
 * User-owned MCP servers in `$VELLUM_WORKSPACE_DIR/mcp.json`.
 *
 * The file is an Agent Plugins 1.0.0 document (`$schema` + `mcpServers`).
 * This module is the only reader and writer of that file. Presence of a
 * server starts it. Headers are never persisted here.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { McpConfig, McpServerConfig } from "../config/schemas/mcp.js";
import { McpConfigSchema } from "../config/schemas/mcp.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceMcpConfigPath } from "../util/platform.js";
import {
  AGENT_PLUGINS_MCP_SCHEMA_URL,
  projectSpecServerToTransport,
  projectTransportToSpecServer,
  SpecMcpDocumentSchema,
  SpecMcpServerSchema,
} from "./spec-schema.js";

const log = getLogger("workspace-mcp-config");

export type WorkspaceMcpFileState = "missing" | "ok" | "invalid";

export interface WorkspaceMcpLoadResult {
  readonly config: McpConfig;
  readonly issues: readonly string[];
  readonly fileState: WorkspaceMcpFileState;
}

/**
 * Read `/workspace/mcp.json` and project it onto the in-memory MCP config.
 *
 * A missing file is an empty server map. An invalid file disables the
 * workspace half only (plugin servers still load) and is reported so a
 * write can refuse to overwrite it.
 */
export function readWorkspaceMcpFile(
  path: string = getWorkspaceMcpConfigPath(),
): WorkspaceMcpLoadResult {
  if (!existsSync(path)) {
    return {
      config: McpConfigSchema.parse({}),
      issues: [],
      fileState: "missing",
    };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const message = `mcp.json unreadable: ${err instanceof Error ? err.message : String(err)}`;
    return {
      config: McpConfigSchema.parse({}),
      issues: [message],
      fileState: "invalid",
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const message = `mcp.json invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
    return {
      config: McpConfigSchema.parse({}),
      issues: [message],
      fileState: "invalid",
    };
  }

  const document = SpecMcpDocumentSchema.safeParse(json);
  if (!document.success) {
    return {
      config: McpConfigSchema.parse({}),
      issues: ['mcp.json is missing a valid "mcpServers" object'],
      fileState: "invalid",
    };
  }

  const servers: Record<string, McpServerConfig> = {};
  const issues: string[] = [];

  for (const [serverKey, rawEntry] of Object.entries(document.data.mcpServers)) {
    if (serverKey.trim().length === 0) {
      issues.push("server key must be a non-empty string; skipping");
      continue;
    }

    const entry = SpecMcpServerSchema.safeParse(rawEntry);
    if (!entry.success) {
      issues.push(
        `invalid server entry "${serverKey}": ${entry.error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; ")}`,
      );
      continue;
    }

    if (entry.data.type === "stdio" && entry.data.cwd) {
      issues.push(
        `"${serverKey}": "cwd" is not supported by this host and was ignored; the server runs in the assistant's working directory`,
      );
    }

    servers[serverKey] = {
      transport: projectSpecServerToTransport(entry.data),
    };
  }

  return {
    config: { servers },
    issues,
    fileState: "ok",
  };
}

/** Load the workspace MCP config, logging any declaration problems. */
export function loadWorkspaceMcpConfig(): McpConfig {
  const result = readWorkspaceMcpFile();
  for (const issue of result.issues) {
    log.warn(issue);
  }
  return result.config;
}

/**
 * Refuse a write when `mcp.json` exists but is not a usable document, so a
 * later add/remove cannot clobber a hand-edit the user still means to fix.
 */
export function assertWorkspaceMcpWritable(): void {
  const result = readWorkspaceMcpFile();
  if (result.fileState === "invalid") {
    throw new Error(result.issues[0] ?? "mcp.json is not a valid document");
  }
}

/** Persist the in-memory workspace MCP config as a spec-pure document. */
export function saveWorkspaceMcpConfig(config: McpConfig): void {
  assertWorkspaceMcpWritable();
  const path = getWorkspaceMcpConfigPath();
  const mcpServers: Record<string, unknown> = {};
  for (const [id, server] of Object.entries(config.servers)) {
    mcpServers[id] = projectTransportToSpecServer(server.transport);
  }

  const document = {
    $schema: AGENT_PLUGINS_MCP_SCHEMA_URL,
    mcpServers,
  };

  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(document, null, 2) + "\n");
  renameSync(tmpPath, path);
}

/**
 * Replace `config.mcp` on a settings/export payload with the projected
 * workspace servers (transport only, headers stripped). Old clients that
 * still read `mcp.servers` from `/v1/config` keep seeing the same shape.
 */
export function overlayWorkspaceMcpForConfigRead(config: unknown): void {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return;
  }
  const root = config as Record<string, unknown>;
  const { servers } = loadWorkspaceMcpConfig();
  const projected: Record<string, unknown> = {};
  for (const [id, server] of Object.entries(servers)) {
    const { headers: _headers, ...safeTransport } = server.transport as Record<
      string,
      unknown
    >;
    projected[id] = { transport: safeTransport };
  }
  root.mcp = { servers: projected };
}
