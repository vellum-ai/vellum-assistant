import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Swap the managed quality-optimized profile from Anthropic Opus 4.8 to GLM 5.2
// (Fireworks), and repoint the default advisor at the new `frontier` profile.
//
// The managed quality-optimized intent now pins GLM 5.2, while the new managed
// `frontier` profile carries the Opus 4.8 config the quality profile used to
// have. The seeder reconciles managed-profile content from the code templates
// on every boot — but it only consults those templates when it actually
// reseeds a profile: off-platform installs reseed on every boot, while a
// platform workspace keeps the profile it was hatched with (the seeder skips
// overlay-supplied profiles, and the overlay is consumed once). A platform
// workspace holding an Opus 4.8 quality-optimized profile therefore keeps it
// until this migration rewrites it.
//
// Only the managed quality-optimized profile is touched — the user-owned
// custom-quality-optimized copy is theirs to manage. Within it, only a profile
// still on Opus 4.8 is rewritten (matching by model value also covers the
// OpenRouter-prefixed id). A profile whose model the user changed to anything
// else is left untouched.
//
// The `frontier` profile itself is materialized by the boot seeder (it is a new
// managed template, added to every workspace on the next boot), so this
// migration only needs to relabel the default advisor pointer from
// `quality-optimized` to `frontier` when the workspace still uses the default.

const OPUS_48_MODEL_IDS = new Set([
  "claude-opus-4-8",
  "anthropic/claude-opus-4.8",
]);

const GLM_52_MODEL = "accounts/fireworks/models/glm-5p2";

export const swapQualityProfileToGlm52Migration: WorkspaceMigration = {
  id: "109-swap-quality-profile-to-glm-5p2",
  description:
    "Swap the managed quality-optimized profile from Opus 4.8 to GLM 5.2 and repoint the advisor at frontier",
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

    let changed = false;

    const profiles = readObject(llm.profiles);
    if (profiles !== null) {
      const profile = readObject(profiles["quality-optimized"]);
      // Only the managed profile is ours to migrate; a user-owned profile of the
      // same name is left untouched.
      if (
        profile !== null &&
        profile.source === "managed" &&
        typeof profile.model === "string" &&
        OPUS_48_MODEL_IDS.has(profile.model)
      ) {
        profile.model = GLM_52_MODEL;
        profile.provider = "fireworks";
        profile.provider_connection = "fireworks-managed";
        // The Opus profile defaulted the advisor off because it was the
        // advisor's own (strongest) profile. GLM 5.2 no longer holds that role —
        // `frontier` does — so clear the seeded default and let it fall back to
        // advisor-on. A user who explicitly toggled it keeps their choice (the
        // value would not be the seeded `false`).
        if (profile.advisorEnabled === false) {
          delete profile.advisorEnabled;
        }
        profiles["quality-optimized"] = profile;
        llm.profiles = profiles;
        changed = true;
      }
    }

    // Move the default advisor pointer to the new strongest managed profile.
    // Only the seeded default (`quality-optimized`) is rewritten; a workspace
    // that picked its own advisor profile keeps it. Skip the rewrite when a
    // user already owns a profile named `frontier`: the seeder leaves that
    // user profile in place rather than materializing the managed Opus one, so
    // pointing the advisor at it would consult an arbitrary user model. Leaving
    // the advisor on `quality-optimized` (now managed GLM 5.2) is the safe
    // fallback in that collision case.
    const frontierIsUserOwned =
      readObject(profiles?.frontier)?.source === "user";
    if (llm.advisorProfile === "quality-optimized" && !frontierIsUserOwned) {
      llm.advisorProfile = "frontier";
      changed = true;
    }

    if (changed) {
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
