import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Move the managed quality-optimized profile from Anthropic Opus 4.8 back to
// Claude Fable 5, reversing migration 114.
//
// The quality-optimized intent maps to claude-fable-5, but the intent map is
// only consulted when a profile is seeded: off-platform installs reseed managed
// profiles on every boot, while on-platform workspaces keep the profile they
// were hatched with — the seeder skips existing profiles there, and the hatch
// overlay is consumed exactly once. A platform workspace holding an Opus 4.8
// quality-optimized profile therefore keeps it until a migration rewrites it.
//
// Only the managed quality-optimized profile is touched — the user-owned
// custom-quality-optimized copy is theirs to manage. Within it, only a profile
// still on the Opus default is rewritten — matching by model value also covers
// the OpenRouter-prefixed id. A profile whose model the user changed to
// anything else is left untouched. The profile key stays quality-optimized, so
// persisted inference_profile pins on conversations/schedules keep resolving.

const TARGET_PROFILES = ["quality-optimized"];

const MODEL_SWAPS: Record<string, string> = {
  "claude-opus-4-8": "claude-fable-5",
  "anthropic/claude-opus-4.8": "anthropic/claude-fable-5",
};

export const swapQualityProfileToFableMigration: WorkspaceMigration = {
  id: "123-swap-quality-profile-to-fable",
  description:
    "Move the managed quality-optimized profile from Anthropic Opus 4.8 to Claude Fable 5",
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
      if (profile.source === "user") continue;
      if (typeof profile.model !== "string") continue;

      const swapped = MODEL_SWAPS[profile.model];
      if (swapped === undefined) continue;

      profile.model = swapped;
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
