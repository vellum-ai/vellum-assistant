import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

const AUTO_PROFILE = "auto";
const FALLBACK_PROFILE = "balanced";

export const dropAutoProfileMigration: WorkspaceMigration = {
  id: "110-drop-auto-profile",
  description:
    "Remove the Auto profile from workspace config and repoint references to Balanced",
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
    const fallback =
      profiles !== null && readObject(profiles[FALLBACK_PROFILE]) !== null
        ? FALLBACK_PROFILE
        : undefined;
    let changed = false;

    if (profiles !== null && AUTO_PROFILE in profiles) {
      delete profiles[AUTO_PROFILE];
      changed = true;
    }

    if (Array.isArray(llm.profileOrder)) {
      const order = llm.profileOrder as unknown[];
      const pruned = order.filter((name) => name !== AUTO_PROFILE);
      if (pruned.length !== order.length) {
        llm.profileOrder = pruned;
        changed = true;
      }
    }

    const callSites = readObject(llm.callSites);
    if (callSites !== null) {
      for (const value of Object.values(callSites)) {
        const site = readObject(value);
        if (site === null || site.profile !== AUTO_PROFILE) continue;
        if (fallback) {
          site.profile = fallback;
        } else {
          delete site.profile;
        }
        changed = true;
      }
    }

    if (profiles !== null) {
      for (const value of Object.values(profiles)) {
        const profile = readObject(value);
        if (profile === null || !Array.isArray(profile.mix)) continue;

        const nextMix: unknown[] = [];
        let mixChanged = false;
        for (const arm of profile.mix) {
          const armObj = readObject(arm);
          if (armObj !== null && armObj.profile === AUTO_PROFILE) {
            mixChanged = true;
            if (fallback) {
              armObj.profile = fallback;
              nextMix.push(armObj);
            }
            continue;
          }
          nextMix.push(arm);
        }

        if (mixChanged) {
          if (nextMix.length > 0) {
            profile.mix = nextMix;
          } else {
            delete profile.mix;
          }
          changed = true;
        }
      }
    }

    if (llm.activeProfile === AUTO_PROFILE) {
      if (fallback) {
        llm.activeProfile = fallback;
        const fallbackEntry = readObject(profiles?.[fallback]);
        if (fallbackEntry !== null && fallbackEntry.status === "disabled") {
          delete fallbackEntry.status;
        }
      } else {
        delete llm.activeProfile;
      }
      changed = true;
    }

    if (llm.advisorProfile === AUTO_PROFILE) {
      if (fallback) {
        llm.advisorProfile = fallback;
      } else {
        delete llm.advisorProfile;
      }
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
