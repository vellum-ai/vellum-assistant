/**
 * Boot-time backfill: migrates existing config.json profiles from the legacy
 * `provider` + `source` model to the new `provider_connection` model.
 *
 * Idempotent: profiles that already have `provider_connection` are skipped.
 * Only modifies config.json when at least one profile needs updating.
 */

import { loadRawConfig, saveRawConfig } from "../../config/loader.js";
import type { DrizzleDb } from "../../memory/db-connection.js";
import { credentialKey } from "../../security/credential-key.js";
import { getLogger } from "../../util/logger.js";
import { createConnection, getConnection, seedCanonicalConnections } from "./connections.js";

const log = getLogger("provider-connections-backfill");

// Providers that support the managed (platform) auth type.
const MANAGED_PROVIDERS = new Set(["anthropic", "openai", "gemini"]);

/**
 * Run on every daemon boot.
 *
 * 1. Seeds canonical connections (idempotent).
 * 2. Walks `llm.profiles.*` in config.json.
 * 3. For each profile without `provider_connection`, derives one based on
 *    the profile's `source` and `provider` fields and writes it back.
 * 4. Saves config.json if any profiles were updated.
 */
export function runProviderConnectionsBackfill(db: DrizzleDb): void {
  try {
    seedCanonicalConnections(db);
    backfillConfigProfiles(db);
  } catch (err) {
    log.error({ err }, "provider_connections backfill failed — will retry on next boot");
  }
}

function backfillConfigProfiles(db: DrizzleDb): void {
  const raw = loadRawConfig();
  const llm = raw.llm as Record<string, unknown> | undefined;
  if (!llm) return;

  const profiles = llm.profiles as Record<string, unknown> | undefined;
  if (!profiles || typeof profiles !== "object") return;

  let changed = false;

  for (const [profileName, profileVal] of Object.entries(profiles)) {
    const profile = profileVal as Record<string, unknown>;
    if (!profile || typeof profile !== "object") continue;

    // Skip profiles that already have a provider_connection.
    if (profile.provider_connection != null) continue;

    const provider = profile.provider as string | undefined;
    if (!provider) continue;

    // Route on the auth axis (`services.inference.mode`), not the ownership
    // axis (`profile.source` is `managed`/`user`, system-vs-user-created).
    // Conflating them would regress user-owned profiles in managed
    // deployments to require local API keys.
    const inferenceMode = (raw.services as Record<string, unknown> | undefined)
      ?.inference as Record<string, unknown> | undefined;
    const globalMode = (inferenceMode?.mode as string | undefined) ?? "your-own";

    let connectionName: string;

    if (provider === "ollama") {
      connectionName = "ollama-local";
    } else if (globalMode === "managed" && MANAGED_PROVIDERS.has(provider)) {
      connectionName = `${provider}-managed`;
    } else {
      // "your-own" path (or provider not managed-supported): ensure a personal connection exists.
      connectionName = `${provider}-personal`;
      if (!getConnection(db, connectionName)) {
        const credName = credentialKey(provider, "api_key");
        const result = createConnection(db, {
          name: connectionName,
          provider,
          auth: { type: "api_key", credential: credName },
        });
        if (!result.ok) {
          log.warn(
            { profileName, provider, error: result.error },
            "Failed to create personal connection during backfill; skipping profile",
          );
          continue;
        }
        log.info(
          { connectionName, provider, credential: credName },
          "Created personal connection during backfill",
        );
      }
    }

    profile.provider_connection = connectionName;
    profiles[profileName] = profile;
    changed = true;

    log.info(
      { profileName, connectionName },
      "Backfilled provider_connection for profile",
    );
  }

  if (changed) {
    llm.profiles = profiles;
    raw.llm = llm;
    saveRawConfig(raw);
    log.info("Saved config.json after provider_connection backfill");
  }
}
