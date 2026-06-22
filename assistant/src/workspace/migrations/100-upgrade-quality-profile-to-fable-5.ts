import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Upgrade quality-optimized profiles to Claude Fable 5.
//
// The quality-optimized model intent moved to claude-fable-5 (#34498), but
// the intent map is only consulted when a profile is seeded: off-platform
// installs reseed managed profiles on every boot, while on-platform
// workspaces keep the profile they were hatched with — the seeder skips
// existing profiles there, and the hatch overlay is consumed exactly once.
// Existing platform assistants are therefore stuck on whichever model the
// quality intent pointed at when they hatched (claude-opus-4-7 or
// claude-opus-4-8) until a migration rewrites it.
//
// Only the managed quality-optimized profile is touched — the user-owned
// custom-quality-optimized copy is theirs to manage. Within it, only a model
// still on a previous quality-intent default is upgraded — matching by model
// value also covers the OpenRouter-prefixed ids. A profile whose model the
// user changed to anything else is left untouched.

const TARGET_PROFILES = ["quality-optimized"];

const MODEL_UPGRADES: Record<string, string> = {
  "claude-opus-4-7": "claude-fable-5",
  "claude-opus-4-8": "claude-fable-5",
  "anthropic/claude-opus-4.7": "anthropic/claude-fable-5",
  "anthropic/claude-opus-4.8": "anthropic/claude-fable-5",
};

export const upgradeQualityProfileToFable5Migration: WorkspaceMigration = {
  id: "100-upgrade-quality-profile-to-fable-5",
  description:
    "Upgrade the managed quality-optimized profile from Opus 4.7/4.8 to Claude Fable 5",
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
