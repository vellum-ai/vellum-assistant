import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Fold the Flux provider ids back into their parent plus a model family.
 *
 * Flux shipped as its own `services.stt.provider` value, which made a model
 * choice look like a provider choice. That cost an entry in the provider
 * enum, a row in every settings picker, and a place in each
 * managed-versus-BYOK predicate for a backend that shares its parent's
 * credential and account. Model families now live where the rest of a
 * provider's settings do:
 *
 *   provider: "deepgram-flux"  ->  provider: "deepgram"
 *                                  providers.deepgram.model: "flux"
 *
 * The same rewrite applies to the managed pair. Any other provider value is
 * left untouched, and an existing `providers.<parent>` entry keeps every key
 * it already had.
 *
 * The same pass drops any `providers.<id>.model` a known provider cannot
 * serve. That key was free-form before this change and read by nothing, so
 * existing values carry no meaning, but the schema validates it now: leaving
 * a stale one behind would fail the parse and drop the workspace onto the
 * loader's salvage path, which resets the entire `services` section and takes
 * unrelated STT and TTS settings with it.
 *
 * Idempotent: a config already naming a parent provider has nothing to
 * rewrite, and a model key already naming a family it can serve is left
 * alone.
 */
const FLUX_PROVIDER_PARENTS: Record<string, string> = {
  "deepgram-flux": "deepgram",
  "vellum-flux": "vellum",
};

/**
 * The model families each provider served when this migration was written,
 * inlined rather than read from the provider catalog.
 *
 * A published migration has to behave identically every time it runs, and it
 * reruns on newly initialized workspaces and after an interrupted checkpoint.
 * Reading the live catalog would let a later change to it alter what this
 * migration deletes from configs it has already seen.
 */
const KNOWN_MODEL_FAMILIES: Record<string, readonly string[]> = {
  deepgram: ["nova-3", "flux"],
  vellum: ["nova-3", "flux"],
};

export const sttFluxProviderToModelFamilyMigration: WorkspaceMigration = {
  id: "150-stt-flux-provider-to-model-family",
  description:
    "Rewrite services.stt.provider Flux ids to the parent provider plus providers.<id>.model",
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

    const services = asRecord(config.services);
    const stt = asRecord(services?.stt);
    if (!stt || typeof stt.provider !== "string") {
      return;
    }

    const providers = asRecord(stt.providers) ?? {};
    let changed = dropUnservableModels(providers);

    const parent = FLUX_PROVIDER_PARENTS[stt.provider];
    if (parent !== undefined) {
      stt.provider = parent;
      const parentSettings = asRecord(providers[parent]) ?? {};
      parentSettings.model = "flux";
      providers[parent] = parentSettings;
      changed = true;
    }

    if (!changed) {
      return;
    }

    stt.providers = providers;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  },

  down(_workspaceDir: string): void {
    // Forward-only: the Flux provider ids are gone from the config enum, so
    // restoring one would produce a config the schema rejects.
  },
};

/**
 * Remove `model` values a provider known at the time of writing cannot serve.
 * Entries for any other provider are left untouched: that map is deliberately
 * open to ids from future builds, and the schema does not validate them
 * either.
 */
function dropUnservableModels(providers: Record<string, unknown>): boolean {
  let changed = false;
  for (const [providerId, value] of Object.entries(providers)) {
    const settings = asRecord(value);
    if (!settings || settings.model === undefined) {
      continue;
    }
    const families = KNOWN_MODEL_FAMILIES[providerId];
    if (families === undefined) {
      continue;
    }
    if (
      typeof settings.model !== "string" ||
      !families.includes(settings.model)
    ) {
      delete settings.model;
      changed = true;
    }
  }
  return changed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
