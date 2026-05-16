/**
 * Boot-time backfill: migrates existing config.json from the legacy
 * `provider` + `source` model to the new `provider_connection` model.
 *
 * Walks three locations in `llm.*` on every boot:
 *   - `llm.default`           — the base profile every dispatch falls back on
 *   - `llm.profiles.*`        — named alternate profiles (fast/balanced/...)
 *   - `llm.callSites.*`       — per-call-site overrides with bare `provider`
 *
 * Idempotent: any object that already has `provider_connection` is skipped.
 * Only modifies config.json when at least one location needs updating.
 *
 * The `default` and `callSites` walks were added alongside Phase 1.1 of the
 * post-v1 inference-providers cleanup: dispatch now throws on missing
 * `provider_connection` instead of silently falling back to legacy
 * `getProvider(name)`, so existing configs need an explicit field on the
 * default profile and on any legacy bare-`provider` callsite override.
 */

import { loadRawConfig, saveRawConfig } from "../../config/loader.js";
import type { DrizzleDb } from "../../memory/db-connection.js";
import { credentialKey } from "../../security/credential-key.js";
import { getLogger } from "../../util/logger.js";
import {
  createConnection,
  getConnection,
  PROVIDERS_REQUIRING_BASE_URL_AND_MODELS,
  seedCanonicalConnections,
} from "./connections.js";

const log = getLogger("provider-connections-backfill");

// Providers that support the managed (platform) auth type.
const MANAGED_PROVIDERS = new Set(["anthropic", "openai", "gemini"]);

/**
 * Seed canonical provider_connections and backfill any legacy config locations
 * that pre-date the connection field.
 *
 * Runs on every daemon boot — both halves are idempotent and cheap
 * (O(profiles + callSites), typically ≤20 entries total). Designed to:
 *   - propagate new canonical connections as they're added in future versions
 *   - self-heal manual config.json edits that drop the connection field
 *
 * Steps:
 *   1. Upsert canonical connections.
 *   2. Walk `llm.default`, `llm.profiles.*`, `llm.callSites.*` in config.json.
 *   3. For each entry without `provider_connection`, derive one from the
 *      entry's `provider` field + the global inference mode and write it back.
 *   4. Save config.json if any entry was updated.
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

  const isPlatform =
    process.env.IS_PLATFORM === "true" || process.env.IS_PLATFORM === "1";
  const globalMode = isPlatform ? "managed" : "your-own";

  let changed = false;

  // 1. The default profile — every dispatch path's terminal fallback.
  const defaultProfile = llm.default as Record<string, unknown> | undefined;
  if (defaultProfile && typeof defaultProfile === "object") {
    if (ensureProviderConnection(defaultProfile, "<llm.default>", db, globalMode)) {
      llm.default = defaultProfile;
      changed = true;
    }
  }

  // 2. Named alternate profiles.
  const profiles = llm.profiles as Record<string, unknown> | undefined;
  if (profiles && typeof profiles === "object") {
    for (const [profileName, profileVal] of Object.entries(profiles)) {
      const profile = profileVal as Record<string, unknown>;
      if (!profile || typeof profile !== "object") continue;
      if (ensureProviderConnection(profile, profileName, db, globalMode)) {
        profiles[profileName] = profile;
        changed = true;
      }
    }
    if (changed) llm.profiles = profiles;
  }

  // 3. Per-call-site overrides. Only legacy entries with a bare `provider`
  //    field need backfill — entries that just point at a `profile` already
  //    inherit `provider_connection` from there.
  const callSites = llm.callSites as Record<string, unknown> | undefined;
  if (callSites && typeof callSites === "object") {
    for (const [callSiteName, callSiteVal] of Object.entries(callSites)) {
      const callSite = callSiteVal as Record<string, unknown>;
      if (!callSite || typeof callSite !== "object") continue;
      // Only touch overrides that explicitly set `provider` — the typical
      // case is `{profile: "fast"}`, which has no provider and inherits
      // through `resolveCallSiteConfig` deep-merge.
      if (callSite.provider == null) continue;
      if (
        ensureProviderConnection(
          callSite,
          `<llm.callSites.${callSiteName}>`,
          db,
          globalMode,
        )
      ) {
        callSites[callSiteName] = callSite;
        changed = true;
      }
    }
    if (changed) llm.callSites = callSites;
  }

  if (changed) {
    raw.llm = llm;
    saveRawConfig(raw);
    log.info("Saved config.json after provider_connection backfill");
  }
}

/**
 * Ensure a profile-shaped config object has `provider_connection` set.
 *
 * Mutates `entry` in place when it has `provider` but no `provider_connection`,
 * deriving the canonical connection name from the global auth mode. If a
 * `*-personal` connection is needed and doesn't yet exist in the DB, this
 * also creates it (lazy bootstrap of user-mode credential rows).
 *
 * Returns `true` if the entry was changed, `false` otherwise.
 */
function ensureProviderConnection(
  entry: Record<string, unknown>,
  entryLabel: string,
  db: DrizzleDb,
  globalMode: string,
): boolean {
  // Treat empty/whitespace strings the same as missing — `resolveDefaultProvider`
  // (and friends) use a falsy check on the field, so a manually cleared
  // `provider_connection: ""` would otherwise skip backfill and then hard-throw
  // at runtime. Self-heal those alongside null/undefined.
  const existing = entry.provider_connection;
  const hasValid =
    typeof existing === "string" && existing.trim() !== "";
  if (hasValid) return false;

  const provider = entry.provider as string | undefined;
  if (!provider) return false;

  if (PROVIDERS_REQUIRING_BASE_URL_AND_MODELS.has(provider)) {
    log.warn(
      { entry: entryLabel, provider },
      "Skipping backfill for provider that requires per-connection base_url/models",
    );
    return false;
  }

  let connectionName: string;

  if (globalMode === "managed" && MANAGED_PROVIDERS.has(provider)) {
    connectionName = `${provider}-managed`;
  } else {
    // "your-own" path (or provider not managed-supported): ensure a
    // personal connection exists. Ollama is keyless, so it gets
    // `auth: { type: "none" }`; everything else gets an api_key
    // pointing at the conventional credential slot.
    connectionName = `${provider}-personal`;
    if (!getConnection(db, connectionName)) {
      const isKeyless = provider === "ollama";
      const credName = credentialKey(provider, "api_key");
      const result = createConnection(db, {
        name: connectionName,
        provider,
        auth: isKeyless
          ? { type: "none" }
          : { type: "api_key", credential: credName },
      });
      if (!result.ok) {
        log.warn(
          { entry: entryLabel, provider, error: result.error },
          "Failed to create personal connection during backfill; skipping entry",
        );
        return false;
      }
      log.info(
        {
          connectionName,
          provider,
          credential: isKeyless ? null : credName,
        },
        "Created personal connection during backfill",
      );
    }
  }

  entry.provider_connection = connectionName;
  log.info(
    { entry: entryLabel, connectionName },
    "Backfilled provider_connection",
  );
  return true;
}
