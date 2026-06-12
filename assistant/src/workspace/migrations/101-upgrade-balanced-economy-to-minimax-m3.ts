import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Switch the Balanced Economy profile from Kimi K2.6 to MiniMax M3.
//
// The Fireworks balanced model intent moved to MiniMax M3 (#34726), but the
// intent map is only consulted when a profile is seeded: off-platform
// installs reseed managed profiles on every boot, while on-platform
// workspaces keep the profile they were hatched with — the seeder skips
// existing profiles there. Existing platform assistants would otherwise stay
// on Kimi K2.6 (including the now-dropped `suppress-cjk` logit-bias preset)
// until a migration rewrites the profile.
//
// Only the managed balanced-economy profile still pointing at the old
// default model is touched — a profile whose model the user changed is left
// alone. The rewrite mirrors the new seed template: MiniMax M3, 32K max
// output tokens, no logit-bias preset.

const OLD_MODEL = "accounts/fireworks/models/kimi-k2p6";
const NEW_MODEL = "accounts/fireworks/models/minimax-m3";

export const upgradeBalancedEconomyToMinimaxM3Migration: WorkspaceMigration = {
  id: "101-upgrade-balanced-economy-to-minimax-m3",
  description:
    "Switch the managed Balanced Economy profile from Kimi K2.6 to MiniMax M3",
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

    const profile = readObject(profiles["balanced-economy"]);
    if (profile === null || profile.model !== OLD_MODEL) return;

    profile.model = NEW_MODEL;
    profile.description =
      "Strong open model (MiniMax M3) at a lower price point";
    profile.maxTokens = 32000;
    delete profile.logitBias;
    profiles["balanced-economy"] = profile;
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
