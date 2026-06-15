import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Move the managed quality-optimized profile from Claude Fable 5 to Opus 4.8.
//
// The quality-optimized intent maps to claude-opus-4-8, but the intent map is
// only consulted when a profile is seeded: off-platform installs reseed
// managed profiles on every boot, while on-platform workspaces keep the
// profile they were hatched with — the seeder skips existing profiles there,
// and the hatch overlay is consumed exactly once. A platform workspace holding
// a Claude Fable 5 quality-optimized profile therefore keeps it until a
// migration rewrites it.
//
// Only the managed quality-optimized profile is touched — the user-owned
// custom-quality-optimized copy is theirs to manage. Within it, only a profile
// still on claude-fable-5 is rewritten — matching by model value also covers
// the OpenRouter-prefixed id. A profile whose model the user changed to
// anything else is left untouched.

const TARGET_PROFILES = ["quality-optimized"];

const MODEL_UPGRADES: Record<string, string> = {
  "claude-fable-5": "claude-opus-4-8",
  "anthropic/claude-fable-5": "anthropic/claude-opus-4.8",
};

export const upgradeQualityProfileToOpus48Migration: WorkspaceMigration = {
  id: "103-upgrade-quality-profile-to-opus-4-8",
  description:
    "Move the managed quality-optimized profile from Claude Fable 5 to Opus 4.8",
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
      if (typeof profile.model !== "string") continue;

      const upgraded = MODEL_UPGRADES[profile.model];
      if (upgraded === undefined) continue;

      profile.model = upgraded;
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
