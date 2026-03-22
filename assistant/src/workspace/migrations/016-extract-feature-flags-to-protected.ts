import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getRootDir } from "../../util/platform.js";
import type { WorkspaceMigration } from "./types.js";

export const extractFeatureFlagsToProtectedMigration: WorkspaceMigration = {
  id: "016-extract-feature-flags-to-protected",
  description:
    "Move assistantFeatureFlagValues from config.json to ~/.vellum/protected/feature-flags.json",

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
      | Record<string, boolean>
      | undefined;
    if (
      !flagValues ||
      typeof flagValues !== "object" ||
      Object.keys(flagValues).length === 0
    ) {
      return; // Nothing to migrate
    }

    // Write feature flags to protected directory
    const protectedDir = join(getRootDir(), "protected");
    mkdirSync(protectedDir, { recursive: true });

    const featureFlagsPath = join(protectedDir, "feature-flags.json");

    // Read existing feature-flags.json if present (may have been written by
    // the gateway in a rolling deployment) so we merge rather than overwrite.
    let existingValues: Record<string, boolean> = {};
    if (existsSync(featureFlagsPath)) {
      try {
        const existing = JSON.parse(readFileSync(featureFlagsPath, "utf-8"));
        if (
          existing.version === 1 &&
          existing.values &&
          typeof existing.values === "object"
        ) {
          existingValues = existing.values;
        }
      } catch {
        // Malformed file — start fresh
      }
    }

    // Merge: config values take precedence, existing keys preserved
    const mergedValues = { ...existingValues, ...flagValues };

    const featureFlagsContent = JSON.stringify(
      { version: 1, values: mergedValues },
      null,
      2,
    );

    const tmpFeatureFlagsPath = featureFlagsPath + ".tmp";
    writeFileSync(tmpFeatureFlagsPath, featureFlagsContent + "\n", "utf-8");
    chmodSync(tmpFeatureFlagsPath, 0o600);
    renameSync(tmpFeatureFlagsPath, featureFlagsPath);

    // Remove assistantFeatureFlagValues from config.json
    delete config.assistantFeatureFlagValues;

    const tmpConfigPath = configPath + ".tmp";
    writeFileSync(
      tmpConfigPath,
      JSON.stringify(config, null, 2) + "\n",
      "utf-8",
    );
    renameSync(tmpConfigPath, configPath);
  },
};
