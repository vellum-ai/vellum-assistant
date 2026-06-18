import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Drop the now-unused `collectUsageData` config key. Usage-telemetry gating is
 * governed solely by the platform `share_analytics` consent cache, so the key
 * is dead. The schema strips unknown keys on the next save, so a stale value is
 * harmless; this migration removes it for cleanliness.
 */
export const dropCollectUsageDataMigration: WorkspaceMigration = {
  id: "106-drop-collect-usage-data",
  description:
    "Remove the unused collectUsageData config key (telemetry is now gated by platform share_analytics consent)",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) return;

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      config = raw as Record<string, unknown>;
    } catch {
      return; // Malformed config — skip
    }

    if (!("collectUsageData" in config)) return;

    delete config.collectUsageData;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // No-op: the forward migration only drops a now-unknown key, and the schema
    // field no longer exists, so there is nothing to restore.
  },
};
