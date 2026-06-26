import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Bring an existing workspace's managed `balanced` profile in line with the
// current code template: it now runs GLM 5.2 (Fireworks) at effort `high`,
// taking over the model the managed `quality-optimized` profile used to serve.
// The slot keeps its own `label` and `description`.
//
// A migration is needed even though the seeder reconciles managed-profile
// content from the templates on every boot, because the seeder only consults a
// template when it reseeds that profile. Off-platform installs reseed every
// boot, but a platform workspace keeps the profile it was hatched with (the
// seeder skips overlay-supplied profiles, and the overlay is consumed once). A
// platform workspace whose `balanced` profile still resolves to Together
// MiniMax M3 therefore relies on this migration to move it to GLM 5.2.
//
// Scope: only the managed `balanced` profile is rewritten. `balanced` is a
// canonical name reserved since migration 052, which seeded it source-less, so
// absent `source` means legacy managed — treat it as ours. An explicit
// `source: "user"` (a profile the user took ownership of) or one whose model the
// user retargeted to something other than the MiniMax/GLM defaults is left
// untouched. The profile key stays `balanced`, so persisted `inference_profile`
// pins on conversations/schedules keep resolving.
//
// Two on-disk states are reconciled:
//   1. Still on Together MiniMax M3 (`OLD_MODEL`): swap to GLM 5.2 on Fireworks
//      at effort `high`, and drop the seeded `topP`.
//   2. Already on GLM 5.2 (`NEW_MODEL`): the boot seeder may have rewritten the
//      model before this migration ran (it runs on every boot, even when DB
//      init failure skips the migration runner) while preserving the old
//      `topP: 0.95` by key-presence. Strip that stale seeded `topP` so the
//      profile matches the new template, which carries no sampling override.
//
// In both cases only the seeded default `topP` (0.95) is dropped — a
// user-customized `topP` (any other value) is preserved. Matching on the model
// id keeps the migration idempotent and leaves a user-retargeted profile alone.

const OLD_MODEL = "MiniMaxAI/MiniMax-M3";
const NEW_MODEL = "accounts/fireworks/models/glm-5p2";
const SEEDED_TOP_P = 0.95;

export const swapBalancedProfileToGlm52Migration: WorkspaceMigration = {
  id: "113-swap-balanced-profile-to-glm-5p2",
  description: "Set the managed balanced profile to GLM 5.2 (Fireworks)",
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

    const profile = readObject(profiles["balanced"]);
    if (profile === null || profile.source === "user") return;

    let changed = false;
    if (profile.model === OLD_MODEL) {
      profile.model = NEW_MODEL;
      profile.provider = "fireworks";
      profile.provider_connection = "fireworks-managed";
      profile.effort = "high";
      changed = true;
    }
    // Drop the stale seeded topP — whether we just swapped from MiniMax above or
    // the boot seeder already rewrote the model to GLM (carrying topP by
    // key-presence) before this migration had a chance to run.
    if (profile.model === NEW_MODEL && profile.topP === SEEDED_TOP_P) {
      delete profile.topP;
      changed = true;
    }
    if (!changed) return;

    profiles["balanced"] = profile;
    llm.profiles = profiles;
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
