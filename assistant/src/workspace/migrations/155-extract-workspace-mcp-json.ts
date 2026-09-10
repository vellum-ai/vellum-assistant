import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const WORKSPACE_MCP_FILENAME = "mcp.json";

// Inlined Agent Plugins 1.0.0 schema URL so this migration stays
// self-contained if the production constant later changes or moves.
const AGENT_PLUGINS_MCP_SCHEMA_URL =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const log = getLogger("workspace-migration-155");

/**
 * Move user-owned MCP servers from `config.json` into a spec-pure
 * `/workspace/mcp.json`. Presence of a server is what starts it. Headers
 * that were still on a transport are copied onto the spec entry so the
 * credential-store migration can lift them on the next MCP reload.
 */
export const extractWorkspaceMcpJsonMigration: WorkspaceMigration = {
  id: "155-extract-workspace-mcp-json",
  description:
    "Extract workspace MCP servers from config.json into a spec-pure mcp.json",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    const config = readJsonObject(configPath);
    if (config === null) {
      return;
    }

    if (!Object.hasOwn(config, "mcp")) {
      return;
    }

    const extracted = extractSpecServers(config.mcp);
    const mcpPath = join(workspaceDir, WORKSPACE_MCP_FILENAME);
    const existing = readExistingMcpServers(mcpPath);
    const merged: Record<string, unknown> = {
      ...extracted,
      ...existing.servers,
    };

    if (Object.keys(merged).length > 0 || existing.present) {
      const document = {
        $schema: existing.schema ?? AGENT_PLUGINS_MCP_SCHEMA_URL,
        mcpServers: merged,
      };
      atomicWrite(mcpPath, document);
    }

    delete config.mcp;
    atomicWrite(configPath, config);
    log.info("Extracted workspace MCP servers into mcp.json");
  },
  retryFailedCheckpoint: true,
  down(_workspaceDir: string): void {
    // Forward-only: mcp.json is the store. Putting servers back under
    // config.json would just be extracted again on the next load.
  },
};

function extractSpecServers(mcp: unknown): Record<string, unknown> {
  const block = readObject(mcp);
  if (block === null) {
    return {};
  }

  const servers: Record<string, unknown> = {};
  const rawServers = block.servers;
  if (Array.isArray(rawServers)) {
    for (const entry of rawServers) {
      const object = readObject(entry);
      if (object === null) {
        continue;
      }
      const name = object.name;
      if (typeof name !== "string" || name.trim().length === 0) {
        continue;
      }
      const spec = toSpecServer(object);
      if (spec !== null) {
        servers[name] = spec;
      }
    }
    return servers;
  }

  const serverMap = readObject(rawServers);
  if (serverMap === null) {
    return {};
  }
  for (const [id, entry] of Object.entries(serverMap)) {
    if (id.trim().length === 0) {
      continue;
    }
    const object = readObject(entry);
    if (object === null) {
      continue;
    }
    const spec = toSpecServer(object);
    if (spec !== null) {
      servers[id] = spec;
    }
  }
  return servers;
}

function toSpecServer(entry: Record<string, unknown>): Record<string, unknown> | null {
  const transport = readObject(entry.transport);
  if (transport === null) {
    return null;
  }
  const type = transport.type;
  if (type === "stdio") {
    if (typeof transport.command !== "string" || transport.command.length === 0) {
      return null;
    }
    const spec: Record<string, unknown> = {
      type: "stdio",
      command: transport.command,
    };
    if (
      Array.isArray(transport.args) &&
      transport.args.length > 0 &&
      transport.args.every((arg) => typeof arg === "string")
    ) {
      spec.args = transport.args;
    }
    const env = readStringRecord(transport.env);
    if (env !== null) {
      spec.env = env;
    }
    return spec;
  }
  if (type === "sse" || type === "streamable-http" || type === "http") {
    if (typeof transport.url !== "string" || transport.url.length === 0) {
      return null;
    }
    const spec: Record<string, unknown> = {
      type: type === "http" ? "streamable-http" : type,
      url: transport.url,
    };
    const headers = readStringRecord(transport.headers);
    if (headers !== null) {
      spec.headers = headers;
    }
    return spec;
  }
  return null;
}

function readExistingMcpServers(path: string): {
  present: boolean;
  schema?: string;
  servers: Record<string, unknown>;
} {
  if (!existsSync(path)) {
    return { present: false, servers: {} };
  }
  const document = readJsonObject(path);
  if (document === null) {
    return { present: true, servers: {} };
  }
  const servers = readObject(document.mcpServers);
  return {
    present: true,
    schema:
      typeof document.$schema === "string" ? document.$schema : undefined,
    servers: servers ?? {},
  };
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return readObject(raw);
  } catch {
    return null;
  }
}

function atomicWrite(path: string, value: unknown): void {
  const tmpPath = `${path}.migration-155.tmp`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmpPath, path);
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readStringRecord(value: unknown): Record<string, string> | null {
  const object = readObject(value);
  if (object === null) {
    return null;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (typeof entry !== "string") {
      return null;
    }
    result[key] = entry;
  }
  return Object.keys(result).length > 0 ? result : null;
}
