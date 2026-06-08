import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const SIXTY_MINUTES_MS = 60 * 60 * 1000;

/**
 * Bump persisted heartbeat default from 30 minutes to 60 minutes.
 *
 * Migration 065 moved legacy 3h/6h defaults to 30 minutes. The schema default
 * has since been raised to 60 minutes, but existing users whose config.json
 * already has 1800000 persisted won't pick up the new default. This migration
 * idempotently updates those configs.
 */
export const bumpHeartbeatInterval30mTo60mMigration: WorkspaceMigration = {
  id: "095-bump-heartbeat-interval-30m-to-60m",
  description:
    "Bump persisted heartbeat.intervalMs from 30 minutes to 60 minutes",
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
    if (typeof intervalMs !== "number" || intervalMs !== THIRTY_MINUTES_MS) {
      return;
    }

    heartbeatConfig.intervalMs = SIXTY_MINUTES_MS;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: cannot distinguish users who explicitly chose 60 minutes
    // from those migrated by this migration.
  },
};
