import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Bring an existing workspace's managed `quality-optimized` profile in line with
// the current code template: it now runs Anthropic Opus (the same model as the
// managed `frontier` profile), taking over the config `frontier` carries. The
// managed `balanced` profile takes over the GLM 5.2 model `quality-optimized`
// used to serve (migration 113).
//
// A migration is needed even though the seeder reconciles managed-profile
// content from the templates on every boot, because the seeder only consults a
// template when it reseeds that profile. Off-platform installs reseed every
// boot, but a platform workspace keeps the profile it was hatched with (the
// seeder skips overlay-supplied profiles, and the overlay is consumed once). A
// platform workspace whose `quality-optimized` profile resolves to GLM 5.2
// therefore relies on this migration to move it to Opus.
//
// Scope: only the managed `quality-optimized` profile still on the GLM 5.2
// default is rewritten. `quality-optimized` is a canonical name reserved since
// migration 052, which seeded it source-less, so absent `source` means legacy
// managed — treat it as ours. An explicit `source: "user"` (a profile the user
// took ownership of) or one whose model the user changed is left untouched.
// Matching on the GLM model id keeps the migration idempotent and leaves a
// user-retargeted profile alone. The profile key stays `quality-optimized`, so
// persisted `inference_profile` pins on conversations/schedules keep resolving.

const OLD_MODEL = "accounts/fireworks/models/glm-5p2";
const NEW_MODEL = "claude-opus-4-8";

export const swapQualityProfileToOpusMigration: WorkspaceMigration = {
  id: "114-swap-quality-profile-to-opus",
  description:
    "Set the managed quality-optimized profile to Anthropic Opus (matching frontier)",
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

    const profile = readObject(profiles["quality-optimized"]);
    if (
      profile === null ||
      profile.source === "user" ||
      profile.model !== OLD_MODEL
    ) {
      return;
    }

    profile.model = NEW_MODEL;
    profile.provider = "anthropic";
    profile.provider_connection = "anthropic-managed";
    profile.description = "High-quality results with the most capable model";
    profiles["quality-optimized"] = profile;
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
