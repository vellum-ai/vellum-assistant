import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

export const extractCollectUsageDataMigration: WorkspaceMigration = {
  id: "004-extract-collect-usage-data",
  description:
    "Move collect-usage-data opt-out from assistantFeatureFlagValues to top-level collectUsageData config key",
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

    const flagValues = config.assistantFeatureFlagValues as
      | Record<string, unknown>
      | undefined;
    if (!flagValues || typeof flagValues !== "object") return;

    const FLAG_KEY = "feature_flags.collect-usage-data.enabled";
    if (!(FLAG_KEY in flagValues)) return;

    const value = flagValues[FLAG_KEY];
    if (typeof value !== "boolean") return;

    // Only write collectUsageData if the user had explicitly opted out.
    // The schema default is true, so we only need to persist false.
    if (!value) {
      config.collectUsageData = false;
    }

    // Remove from feature flag values
    delete flagValues[FLAG_KEY];

    // Clean up empty assistantFeatureFlagValues object
    if (Object.keys(flagValues).length === 0) {
      delete config.assistantFeatureFlagValues;
    }

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

    // Only reverse if collectUsageData was explicitly set to false
    // (the forward migration only persisted false).
    if (!("collectUsageData" in config)) return;
    const value = config.collectUsageData;
    if (typeof value !== "boolean") return;

    // Restore the feature flag value
    const FLAG_KEY = "feature_flags.collect-usage-data.enabled";
    const flagValues = (config.assistantFeatureFlagValues ?? {}) as Record<
      string,
      unknown
    >;
    flagValues[FLAG_KEY] = value;
    config.assistantFeatureFlagValues = flagValues;

    // Remove the extracted top-level key
    delete config.collectUsageData;

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
};
