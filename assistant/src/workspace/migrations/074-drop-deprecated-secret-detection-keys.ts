import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

const MIGRATION_ID = "074-drop-deprecated-secret-detection-keys";

export const dropDeprecatedSecretDetectionKeysMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description:
    "Strip removed secretDetection.action / entropyThreshold / customPatterns keys from config.json",

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

    const secretDetection = readObject(config.secretDetection);
    if (secretDetection === null) return;

    let mutated = false;
    for (const key of ["action", "entropyThreshold", "customPatterns"]) {
      if (key in secretDetection) {
        delete secretDetection[key];
        mutated = true;
      }
    }

    if (mutated) {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: restoring the deleted keys would re-introduce schema
    // warnings without changing runtime behavior — the post-execution scanner
    // they used to drive no longer exists.
  },
};

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
