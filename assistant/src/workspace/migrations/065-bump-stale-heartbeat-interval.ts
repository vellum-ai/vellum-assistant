import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const LEGACY_DEFAULT_INTERVALS_MS = new Set([
  3 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
]);

/**
 * Bump stale baked heartbeat defaults to 30 minutes.
 *
 * Older first-launch config files materialized the then-current heartbeat
 * default into `config.json`, so changing the schema default alone would not
 * affect existing default users. A workspace could have intentionally selected
 * one of these exact intervals; product intent is still to move legacy 3h/6h
 * heartbeat schedules to the 30-minute default, and those users can reset the
 * interval after upgrade.
 */
export const bumpStaleHeartbeatIntervalMigration: WorkspaceMigration = {
  id: "065-bump-stale-heartbeat-interval",
  description:
    "Bump legacy heartbeat.intervalMs defaults of 3h/6h to the current 30-minute default",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) return;

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const heartbeat = config.heartbeat;
    if (!heartbeat || typeof heartbeat !== "object" || Array.isArray(heartbeat))
      return;

    const heartbeatConfig = heartbeat as Record<string, unknown>;
    const intervalMs = heartbeatConfig.intervalMs;
    if (
      typeof intervalMs !== "number" ||
      !LEGACY_DEFAULT_INTERVALS_MS.has(intervalMs)
    ) {
      return;
    }

    heartbeatConfig.intervalMs = THIRTY_MINUTES_MS;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: the stale value may have been a schema-default artifact,
    // while 30 minutes may also have been explicitly configured later. Without
    // per-workspace state we cannot safely distinguish those cases.
  },
};
