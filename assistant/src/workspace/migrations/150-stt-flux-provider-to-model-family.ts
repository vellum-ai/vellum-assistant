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
 * Idempotent: a config already naming a parent provider has nothing to
 * rewrite, and the model key is only written when the provider was a Flux id.
 */
const FLUX_PROVIDER_PARENTS: Record<string, string> = {
  "deepgram-flux": "deepgram",
  "vellum-flux": "vellum",
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

    const parent = FLUX_PROVIDER_PARENTS[stt.provider];
    if (parent === undefined) {
      return;
    }

    stt.provider = parent;

    const providers = asRecord(stt.providers) ?? {};
    const parentSettings = asRecord(providers[parent]) ?? {};
    parentSettings.model = "flux";
    providers[parent] = parentSettings;
    stt.providers = providers;

    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  },

  down(_workspaceDir: string): void {
    // Forward-only: the Flux provider ids are gone from the config enum, so
    // restoring one would produce a config the schema rejects.
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
