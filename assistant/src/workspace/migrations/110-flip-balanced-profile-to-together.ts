import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Move the managed `balanced` profile from Fireworks MiniMax M3 to Together AI.
//
// Together serves MiniMax M3 with correct forced-`tool_choice` and object-typed
// tool-arg handling; the Fireworks copy collapses object args to `{}`. The boot
// seeder reconciles managed-profile content from the templates, but only when
// it reseeds a profile: off-platform installs reseed every boot, while a
// platform workspace keeps the profile it was hatched with (the seeder skips
// overlay-supplied profiles, and the overlay is consumed once). A platform
// workspace whose `balanced` profile still resolves to Fireworks MiniMax M3
// therefore relies on this migration to move it to Together.
//
// Scope: only the managed `balanced` profile still on the Fireworks MiniMax M3
// default is rewritten. A user-owned `balanced` (`source: "user"`) or one whose
// model the user changed is left alone. Migration 052 seeds `balanced`
// source-less, so absent `source` means legacy managed — treat it as ours. The
// profile key stays `balanced`, so persisted `inference_profile` pins on
// conversations/schedules keep resolving and need no rewrite.

const OLD_MODEL = "accounts/fireworks/models/minimax-m3";
const NEW_MODEL = "MiniMaxAI/MiniMax-M3";

export const flipBalancedProfileToTogetherMigration: WorkspaceMigration = {
  id: "110-flip-balanced-profile-to-together",
  description:
    "Move the managed balanced profile from Fireworks to Together AI (MiniMax M3)",
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
    // Only the managed profile still on the Fireworks MiniMax M3 default is
    // ours to migrate. `balanced` is seeded source-less by migration 052, so
    // absent `source` means legacy managed; only an explicit `source: "user"`
    // is left untouched. Matching on the old model id leaves a user-retargeted
    // profile alone and makes the migration idempotent.
    if (
      profile === null ||
      profile.source === "user" ||
      profile.model !== OLD_MODEL
    ) {
      return;
    }

    profile.model = NEW_MODEL;
    profile.provider = "together";
    profile.provider_connection = "together-managed";
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
