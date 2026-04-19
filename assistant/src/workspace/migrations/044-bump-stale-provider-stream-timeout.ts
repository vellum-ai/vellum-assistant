import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Bump stale `timeouts.providerStreamTimeoutSec: 300` to 1800.
 *
 * The schema default was raised from 300s (5 min) to 1800s (30 min) in
 * PR #22702, but users whose workspace config was written before that change
 * still carry an explicit 300 that overrides the new default, causing streams
 * to abort after 5 minutes with "Anthropic stream timed out after 300s".
 */
export const bumpStaleProviderStreamTimeoutMigration: WorkspaceMigration = {
  id: "044-bump-stale-provider-stream-timeout",
  description:
    "Bump legacy timeouts.providerStreamTimeoutSec: 300 to 1800 to match the current schema default",
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

    const timeouts = config.timeouts;
    if (!timeouts || typeof timeouts !== "object" || Array.isArray(timeouts))
      return;
    const timeoutsObj = timeouts as Record<string, unknown>;

    if (timeoutsObj.providerStreamTimeoutSec !== 300) return;

    timeoutsObj.providerStreamTimeoutSec = 1800;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(workspaceDir: string): void {
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

    const timeouts = config.timeouts;
    if (!timeouts || typeof timeouts !== "object" || Array.isArray(timeouts))
      return;
    const timeoutsObj = timeouts as Record<string, unknown>;

    if (timeoutsObj.providerStreamTimeoutSec !== 1800) return;

    timeoutsObj.providerStreamTimeoutSec = 300;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
};
