import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

const REMOVED_PROFILE_NAME = "auto";

export const removeAutoProfileMigration: WorkspaceMigration = {
  id: "105-remove-auto-profile",
  description:
    "Remove the obsolete auto inference profile from workspace config.json",
  run(workspaceDir: string): void {
    if (process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH) return;

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

    const llm = readObject(config.llm);
    if (llm === null) return;

    let changed = false;

    const profiles = readObject(llm.profiles);
    if (
      profiles !== null &&
      Object.prototype.hasOwnProperty.call(profiles, REMOVED_PROFILE_NAME)
    ) {
      delete profiles[REMOVED_PROFILE_NAME];
      llm.profiles = profiles;
      changed = true;
    }

    if (Array.isArray(llm.profileOrder)) {
      const filtered = llm.profileOrder.filter(
        (name) => name !== REMOVED_PROFILE_NAME,
      );
      if (filtered.length !== llm.profileOrder.length) {
        llm.profileOrder = filtered;
        changed = true;
      }
    }

    if (llm.activeProfile === REMOVED_PROFILE_NAME) {
      llm.activeProfile = "balanced";
      changed = true;
    }

    if (!changed) return;

    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only.
  },
};

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
