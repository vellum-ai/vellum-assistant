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
      // Only the managed profile is ours to migrate. `quality-optimized` is a
      // canonical name reserved since migration 052, which seeded it source-less,
      // so absent `source` means legacy managed — treat it as ours. Only an
      // explicit `source: "user"` (a profile the user took ownership of) is left
      // untouched. Matching by Opus model id also covers the OpenRouter id.
      if (
        profile !== null &&
        profile.source !== "user" &&
        typeof profile.model === "string" &&
        OPUS_48_MODEL_IDS.has(profile.model)
      ) {
        profile.model = GLM_52_MODEL;
        profile.provider = "fireworks";
        profile.provider_connection = "fireworks-managed";
        // Leave `advisorEnabled` untouched. The old Quality template seeded it
        // to `false`, which is indistinguishable from a user who explicitly
        // turned the advisor off for this chat profile, so deleting it could
        // silently reverse that preference. New installs omit the field (advisor
        // on by default); existing installs keep whatever is persisted.
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
    // fallback in that collision case. Any `frontier` present at migration time
    // is user-owned (the managed one is materialized later, at seed time);
    // treat anything not explicitly `source: "managed"` as theirs, since the
    // settings UI saves custom profiles without a `source`.
    const existingFrontier = readObject(profiles?.frontier);
    const frontierIsUserOwned =
      existingFrontier !== null && existingFrontier.source !== "managed";
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
