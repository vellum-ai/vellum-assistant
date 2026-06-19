import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Reclaim the managed `balanced-economy` inference profile. Its
// MiniMax-M3-on-Fireworks config lives on `balanced`, whose content the seeder
// reconciles from the templates on every boot; the seeder never deletes a
// profile, so this migration deletes the managed `balanced-economy` object and
// repoints every reference to it — its `profileOrder` entry, the `activeProfile`
// and `advisorProfile` selections, call-site `profile` overrides, and mix-profile
// arms — onto `balanced`, which resolves to the same MiniMax M3 route. A
// `balanced-economy` profile that the user owns (`source !== "managed"`) is left
// fully intact, references included.

const ECONOMY = "balanced-economy";
const REPLACEMENT = "balanced";

export const dropBalancedEconomyProfileMigration: WorkspaceMigration = {
  id: "108-drop-balanced-economy-profile",
  description:
    "Remove the managed Balanced Economy profile and repoint its references to Balanced",
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
    const economy = profiles !== null ? readObject(profiles[ECONOMY]) : null;

    // A user-owned profile that happens to use this name keeps everything,
    // references included — only the managed profile is reclaimed.
    if (economy !== null && economy.source !== "managed") return;

    let changed = false;

    if (economy !== null && profiles !== null) {
      delete profiles[ECONOMY];
      changed = true;
    }

    if (Array.isArray(llm.profileOrder)) {
      const order = llm.profileOrder as unknown[];
      const pruned = order.filter((name) => name !== ECONOMY);
      if (pruned.length !== order.length) {
        llm.profileOrder = pruned;
        changed = true;
      }
    }

    // Repoint call-site overrides — LLMSchema strips a profile name absent from
    // `llm.profiles` at load, which would drop the equivalent MiniMax route.
    const callSites = readObject(llm.callSites);
    if (callSites !== null) {
      for (const value of Object.values(callSites)) {
        const site = readObject(value);
        if (site !== null && site.profile === ECONOMY) {
          site.profile = REPLACEMENT;
          changed = true;
        }
      }
    }

    // Repoint mix-profile arms — LLMSchema.superRefine rejects a mix arm whose
    // referenced profile is absent, failing config validation at load.
    if (profiles !== null) {
      for (const value of Object.values(profiles)) {
        const entry = readObject(value);
        if (entry === null || !Array.isArray(entry.mix)) continue;
        for (const arm of entry.mix) {
          const armObj = readObject(arm);
          if (armObj !== null && armObj.profile === ECONOMY) {
            armObj.profile = REPLACEMENT;
            changed = true;
          }
        }
      }
    }

    if (llm.activeProfile === ECONOMY) {
      llm.activeProfile = REPLACEMENT;
      changed = true;

      // The replaced selection was an enabled profile, so `balanced` must be
      // usable: a disabled profile is skipped by the resolver and rejected by
      // validation. Clearing the status sticks because the seeder preserves
      // whatever status is on disk.
      const balanced =
        profiles !== null ? readObject(profiles[REPLACEMENT]) : null;
      if (balanced !== null && balanced.status === "disabled") {
        delete balanced.status;
      }
    }

    // The advisor selection is the other top-level profile reference
    // `LLMSchema.superRefine` validates against `llm.profiles`; an unresolvable
    // value invalidates the config and is stripped at load.
    if (llm.advisorProfile === ECONOMY) {
      llm.advisorProfile = REPLACEMENT;
      changed = true;
    }

    if (!changed) return;

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
