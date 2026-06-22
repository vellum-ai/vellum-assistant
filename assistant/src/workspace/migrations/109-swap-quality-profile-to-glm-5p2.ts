import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Bring an existing workspace's managed inference config in line with the
// current code templates: the managed `quality-optimized` profile runs GLM 5.2
// (Fireworks), and the default advisor points at the managed `frontier` (Opus)
// profile.
//
// A migration is needed even though the seeder reconciles managed-profile
// content from the templates on every boot, because the seeder only consults a
// template when it reseeds that profile. Off-platform installs reseed every
// boot, but a platform workspace keeps the profile it was hatched with (the
// seeder skips overlay-supplied profiles, and the overlay is consumed once). A
// platform workspace whose `quality-optimized` profile resolves to Opus
// therefore relies on this migration to move it to GLM 5.2.
//
// Scope: only the managed `quality-optimized` profile is rewritten — the
// user-owned `custom-quality-optimized` copy is theirs to manage, and an
// explicitly user-owned `quality-optimized` is left alone. A profile matches
// only when its model is an Opus id (the OpenRouter-prefixed id included);
// absent `source` on this canonical name means legacy managed (migration 052
// seeds it source-less), so it counts as ours.
//
// The managed `frontier` profile is materialized by the boot seeder (it is a
// managed template), so this migration only points the default advisor at it,
// and only when the workspace still carries the seeded `quality-optimized`
// default and no user-owned `frontier` profile exists.

const OPUS_48_MODEL_IDS = new Set([
  "claude-opus-4-8",
  "anthropic/claude-opus-4.8",
]);

const GLM_52_MODEL = "accounts/fireworks/models/glm-5p2";

export const swapQualityProfileToGlm52Migration: WorkspaceMigration = {
  id: "109-swap-quality-profile-to-glm-5p2",
  description:
    "Set the managed quality-optimized profile to GLM 5.2 and point the default advisor at frontier",
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
        // Leave `advisorEnabled` untouched: a persisted `false` is ambiguous —
        // it can be a seeded default or a deliberate per-profile opt-out — so
        // deleting it could silently re-enable the advisor against the user's
        // intent. Preserving the stored value keeps an explicit opt-out intact.
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
