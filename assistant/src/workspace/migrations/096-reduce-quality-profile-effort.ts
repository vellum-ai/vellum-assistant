import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Reduce effort from "max" to "high" on the quality-optimized profile.
//
// With adaptive thinking enabled, the effort parameter acts as a nudge for
// how much thinking the model does. "max" means "always think with no
// constraints on thinking depth", which defeats adaptive thinking's ability
// to skip or minimize thinking for simple queries. "high" (the API default)
// means "almost always thinks, deep reasoning on complex tasks" — letting
// adaptive thinking decide when full-depth reasoning is actually needed.
//
// This migration patches both managed and user quality-optimized profiles
// that still have effort: "max". It only downgrades "max" → "high"; any
// other effort value is preserved.

const TARGET_PROFILES = ["quality-optimized", "custom-quality-optimized"];

export const reduceQualityProfileEffortMigration: WorkspaceMigration = {
  id: "096-reduce-quality-profile-effort",
  description:
    'Reduce effort from "max" to "high" on quality-optimized profiles to let adaptive thinking work',
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

    const llm = readObject(config.llm);
    if (llm === null) return;

    const profiles = readObject(llm.profiles);
    if (profiles === null) return;

    let changed = false;

    for (const name of TARGET_PROFILES) {
      const profile = readObject(profiles[name]);
      if (profile === null) continue;
      if (profile.effort !== "max") continue;

      profile.effort = "high";
      profiles[name] = profile;
      changed = true;
    }

    if (changed) {
      llm.profiles = profiles;
      config.llm = llm;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    }
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
