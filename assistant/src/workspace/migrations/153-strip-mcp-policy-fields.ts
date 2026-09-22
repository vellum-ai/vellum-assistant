import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-153");

/**
 * Policy fields that used to live on each MCP server entry. They are not
 * part of the Agent Plugins `mcp.json` shape, and they are no longer
 * persisted on workspace MCP config either. Presence of a server is what
 * starts it. Risk, tool caps, and allow/block lists are code-owned.
 */
const SERVER_POLICY_KEYS = [
  "enabled",
  "defaultRiskLevel",
  "maxTools",
  "allowedTools",
  "blockedTools",
] as const;

/** Top-level MCP object field that used to cap tools across every server. */
const MCP_POLICY_KEYS = ["globalMaxTools"] as const;

/**
 * Strip MCP policy fields from `config.json`.
 *
 * The fields are no longer in the schema. Leaving them on disk would keep
 * writing them back through raw-config saves, and a later extract to
 * `mcp.json` would copy them into a spec-closed document.
 */
export const stripMcpPolicyFieldsMigration: WorkspaceMigration = {
  id: "153-strip-mcp-policy-fields",
  description:
    "Strip MCP policy fields (enabled, defaultRiskLevel, maxTools, allow/block lists, globalMaxTools) from config.json",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    const rawText = readFileSync(configPath, "utf-8");

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(rawText);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return;
      }
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const mcp = readObject(config.mcp);
    if (mcp === null) {
      return;
    }

    let changed = false;

    for (const key of MCP_POLICY_KEYS) {
      if (Object.hasOwn(mcp, key)) {
        delete mcp[key];
        changed = true;
      }
    }

    const servers = mcp.servers;
    if (Array.isArray(servers)) {
      for (const entry of servers) {
        if (stripServerPolicy(readObject(entry))) {
          changed = true;
        }
      }
    } else {
      const serverMap = readObject(servers);
      if (serverMap !== null) {
        for (const entry of Object.values(serverMap)) {
          if (stripServerPolicy(readObject(entry))) {
            changed = true;
          }
        }
      }
    }

    if (!changed) {
      return;
    }

    const tmpPath = `${configPath}.migration-153.tmp`;
    writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n");
    renameSync(tmpPath, configPath);
    log.info("Stripped MCP policy fields from config.json");
  },
  retryFailedCheckpoint: true,
  down(_workspaceDir: string): void {
    // Forward-only: the fields are no longer in the schema, so restoring
    // them would just be stripped again on the next load.
  },
};

function stripServerPolicy(server: Record<string, unknown> | null): boolean {
  if (server === null) {
    return false;
  }
  let changed = false;
  for (const key of SERVER_POLICY_KEYS) {
    if (Object.hasOwn(server, key)) {
      delete server[key];
      changed = true;
    }
  }
  return changed;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
