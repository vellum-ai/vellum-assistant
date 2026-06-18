import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Drops the `collectUsageData` config key (gating is governed by the platform
 * `share_analytics` consent). An explicit local opt-out (`collectUsageData:
 * false`) is preserved as `legacyTelemetryOptOut: true` so telemetry stays off
 * regardless of platform consent, which defaults to opt-in and cannot be
 * written by the daemon. A `true`/non-false value carries no opt-out intent, so
 * the key is removed without setting the marker. The schema strips unknown keys
 * on the next save, so a stale value is otherwise harmless.
 */
export const dropCollectUsageDataMigration: WorkspaceMigration = {
  id: "106-drop-collect-usage-data",
  description:
    "Drop collectUsageData; preserve an explicit opt-out as legacyTelemetryOptOut (telemetry is gated by platform share_analytics consent)",
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

    // An explicit opt-out is preserved as a fail-closed marker; any non-false
    // value carries no opt-out intent.
    if (config.collectUsageData === false) {
      config.legacyTelemetryOptOut = true;
    }

    delete config.collectUsageData;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // No-op: the forward migration only removes a key and sets a fail-closed
    // marker, so there is nothing to restore.
  },
};
