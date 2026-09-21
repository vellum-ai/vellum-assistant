import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Move TypeSafe out of the LLM profile system into `services.classification`.
 *
 * Jev (TypeSafe System One) used to be an LLM catalog provider, so the only
 * way to use it was an `llm.profiles.*` entry with `provider: "typesafe"`
 * pinned onto a judge call site. It now belongs to the classification
 * family, which the judges and the memory selector read directly, and
 * "typesafe" is no longer a valid LLM provider: a profile still naming it
 * would fail the loader's provider check.
 *
 * For a config with at least one such profile:
 *
 *   - `services.classification` is written once, as the BYOK route on the
 *     profile's model (the LLM catalog never served TypeSafe through the
 *     platform, so no profile can have been managed). An existing block is
 *     left alone.
 *   - Each TypeSafe profile is deleted.
 *   - Every reference to a deleted profile goes with it: a call site's
 *     `profile` or `fallbackProfile`, the arms of a `mix` (a mix emptied this
 *     way is removed), and the top-level `activeProfile` / `advisorProfile`
 *     pointers. A call-site entry left empty is removed so the shipped
 *     default applies.
 *
 * Idempotent: a config with no TypeSafe profile has nothing to rewrite.
 */
const TYPESAFE_PROVIDER = "typesafe";
const DEFAULT_CLASSIFICATION_MODEL = "jev-latest";

export const moveTypesafeProfilesToClassificationMigration: WorkspaceMigration =
  {
    id: "158-move-typesafe-profiles-to-classification",
    description:
      "Move llm.profiles that name the typesafe provider into services.classification and drop their references",
    run(workspaceDir: string): void {
      const configPath = join(workspaceDir, "config.json");
      if (!existsSync(configPath)) {
        return;
      }

      let config: Record<string, unknown>;
      try {
        config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        // A config that does not parse is the loader's problem to report, not
        // this migration's to guess at.
        return;
      }

      const llm = asRecord(config.llm);
      const profiles = asRecord(llm?.profiles);
      if (!llm || !profiles) {
        return;
      }

      const removed = new Set<string>();
      let model: string = DEFAULT_CLASSIFICATION_MODEL;
      for (const [name, value] of Object.entries(profiles)) {
        const profile = asRecord(value);
        if (profile?.provider !== TYPESAFE_PROVIDER) {
          continue;
        }
        if (
          removed.size === 0 &&
          typeof profile.model === "string" &&
          profile.model
        ) {
          model = profile.model;
        }
        removed.add(name);
        delete profiles[name];
      }
      if (removed.size === 0) {
        return;
      }

      const services = asRecord(config.services) ?? {};
      if (asRecord(services.classification) === null) {
        services.classification = {
          mode: "your-own",
          provider: TYPESAFE_PROVIDER,
          model,
        };
      }
      config.services = services;

      for (const key of ["activeProfile", "advisorProfile"]) {
        if (typeof llm[key] === "string" && removed.has(llm[key] as string)) {
          delete llm[key];
        }
      }

      for (const value of Object.values(profiles)) {
        const profile = asRecord(value);
        if (profile) {
          stripMixArms(profile, removed);
        }
      }

      const callSites = asRecord(llm.callSites);
      if (callSites) {
        for (const [site, value] of Object.entries(callSites)) {
          const entry = asRecord(value);
          if (!entry) {
            continue;
          }
          for (const key of ["profile", "fallbackProfile"]) {
            if (
              typeof entry[key] === "string" &&
              removed.has(entry[key] as string)
            ) {
              delete entry[key];
            }
          }
          stripMixArms(entry, removed);
          if (Object.keys(entry).length === 0) {
            delete callSites[site];
          }
        }
      }

      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    },

    down(_workspaceDir: string): void {
      // Forward-only: "typesafe" is gone from the LLM provider set, so
      // restoring a profile would produce a config the loader rejects.
    },
  };

/** Drop `mix` arms that name a removed profile; drop an emptied `mix`. */
function stripMixArms(
  entry: Record<string, unknown>,
  removed: ReadonlySet<string>,
): void {
  if (!Array.isArray(entry.mix)) {
    return;
  }
  const kept = entry.mix.filter((arm) => {
    const record = asRecord(arm);
    return !(
      typeof record?.profile === "string" && removed.has(record.profile)
    );
  });
  if (kept.length === entry.mix.length) {
    return;
  }
  if (kept.length === 0) {
    delete entry.mix;
  } else {
    entry.mix = kept;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
