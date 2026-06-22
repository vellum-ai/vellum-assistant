import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MigrationRunContext, WorkspaceMigration } from "./types.js";

/**
 * Preserve heartbeat behavior for existing workspaces after the schema
 * default for `heartbeat.enabled` flipped from true to false (heartbeats are
 * now opt-in for new users).
 *
 * Most configs never persist `heartbeat.enabled` — they relied on the old
 * default-on schema behavior, so flipping the default would silently turn
 * heartbeats off on upgrade. This migration writes an explicit
 * `enabled: true` for upgrading workspaces that have no persisted value,
 * keeping their effective behavior unchanged. Workspaces with an explicit
 * `enabled` value (either way) are a user choice and are left untouched.
 * Fresh workspaces are skipped so new users start with heartbeats off.
 */
export const preserveHeartbeatEnabledForExistingWorkspacesMigration: WorkspaceMigration =
  {
    id: "102-preserve-heartbeat-enabled-for-existing-workspaces",
    description:
      "Persist heartbeat.enabled=true for existing workspaces now that the default is off",
    run(workspaceDir: string, ctx?: MigrationRunContext): void {
      // Fresh workspaces get the new opt-in default. Without a context
      // (older callers), treat the workspace as existing — writing
      // enabled=true reproduces the legacy default and never disables
      // heartbeats for anyone.
      if (ctx?.isNewWorkspace) return;

      const configPath = join(workspaceDir, "config.json");

      // Existing workspaces may have no config.json at all (schema defaults
      // are applied in memory at load time); create one so the legacy
      // default-on behavior survives the flip.
      let config: Record<string, unknown> = {};
      if (existsSync(configPath)) {
        try {
          const raw = JSON.parse(readFileSync(configPath, "utf-8"));
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
          config = raw as Record<string, unknown>;
        } catch {
          return;
        }
      }

      if (config.heartbeat === undefined) {
        config.heartbeat = {};
      }
      const heartbeat = config.heartbeat;
      if (
        !heartbeat ||
        typeof heartbeat !== "object" ||
        Array.isArray(heartbeat)
      ) {
        return;
      }

      const heartbeatConfig = heartbeat as Record<string, unknown>;
      if ("enabled" in heartbeatConfig) return;

      heartbeatConfig.enabled = true;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    },
    down(_workspaceDir: string): void {
      // Forward-only: cannot distinguish users who explicitly enabled
      // heartbeats from those opted in by this migration.
    },
  };
