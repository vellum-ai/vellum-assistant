/**
 * Boot-time connection-row repair.
 *
 * Seeds the canonical connection rows and ensures every bare-vendor profile
 * in `llm.default` / `llm.profiles.*` has a connection row to dispatch
 * through, creating the conventional `<provider>-personal` row when it is
 * missing (lazy bootstrap of user-mode credential rows, e.g. a config
 * restored into a fresh workspace whose vault credential survived but whose
 * DB rows did not).
 *
 * Purely a data repair: config.json is read but never written.
 */

import { loadRawConfig } from "../../config/loader.js";
import type { DrizzleDb } from "../../persistence/db-connection.js";
import { credentialKey } from "../../security/credential-key.js";
import { getLogger } from "../../util/logger.js";
import { isConnectionCompatibleWithModel } from "../connection-model-compat.js";
import { MANAGED_ROUTABLE_PROVIDERS } from "../vellum-model-routing.js";
import {
  PROVIDERS_REQUIRING_BASE_URL_AND_MODELS,
  ROUTING_IDENTITY_PROVIDERS,
  VALID_CONNECTION_PROVIDERS,
} from "./auth.js";
import {
  createConnection,
  getConnection,
  listConnections,
  seedCanonicalConnections,
} from "./connections.js";

const log = getLogger("provider-connections-backfill");

/**
 * Seed canonical connection rows and ensure a row exists for every
 * bare-vendor profile.
 *
 * Runs on every daemon boot; both halves are idempotent and cheap
 * (O(profiles), typically ≤20 entries total).
 */
export function ensureProviderConnectionRows(db: DrizzleDb): void {
  try {
    seedCanonicalConnections(db);
    ensureRowsForConfigProfiles(db);
  } catch (err) {
    log.error(
      { err },
      "connection-row repair failed - will retry on next boot",
    );
  }
}

function ensureRowsForConfigProfiles(db: DrizzleDb): void {
  const raw = loadRawConfig();
  const llm = raw.llm as Record<string, unknown> | undefined;
  if (!llm) {
    return;
  }

  const isPlatform =
    process.env.IS_PLATFORM === "true" || process.env.IS_PLATFORM === "1";
  const globalMode = isPlatform ? "managed" : "your-own";

  // The legacy raw base blob, still present in older configs.
  const defaultProfile = llm.default as Record<string, unknown> | undefined;
  if (defaultProfile && typeof defaultProfile === "object") {
    ensureRowForEntry(defaultProfile, "<llm.default>", db, globalMode);
  }

  const profiles = llm.profiles as Record<string, unknown> | undefined;
  if (profiles && typeof profiles === "object") {
    for (const [profileName, profileVal] of Object.entries(profiles)) {
      const profile = profileVal as Record<string, unknown>;
      if (!profile || typeof profile !== "object") {
        continue;
      }
      ensureRowForEntry(profile, profileName, db, globalMode);
    }
  }
}

/**
 * Ensure a connection row exists for a profile-shaped config object with a
 * bare-vendor `provider`. Reads the entry, never mutates it: with a
 * compatible row already present (or the managed route serving the vendor)
 * there is nothing to do; otherwise the conventional `<provider>-personal`
 * row is created with the vendor's auth mapping. Ollama is keyless, so it
 * gets `auth: { type: "none" }`; everything else gets an api_key pointing
 * at the conventional credential slot.
 */
function ensureRowForEntry(
  entry: Record<string, unknown>,
  entryLabel: string,
  db: DrizzleDb,
  globalMode: string,
): void {
  const provider = entry.provider as string | undefined;
  if (!provider) {
    return;
  }

  // Routing identities carry their target in the provider value itself
  // (dispatch resolves the row per-request), an entry-name provider IS a
  // row reference (nothing to bootstrap: its vendor is unknowable here),
  // and per-connection base_url/models providers cannot be conjured from a
  // vendor id alone.
  if (
    ROUTING_IDENTITY_PROVIDERS.has(provider) ||
    !VALID_CONNECTION_PROVIDERS.includes(provider) ||
    PROVIDERS_REQUIRING_BASE_URL_AND_MODELS.has(provider)
  ) {
    return;
  }

  const entryModel = typeof entry.model === "string" ? entry.model : undefined;
  const existingForProvider = listConnections(db, { provider }).find((c) =>
    isConnectionCompatibleWithModel(c, entryModel),
  );
  if (existingForProvider) {
    return;
  }
  if (globalMode === "managed" && MANAGED_ROUTABLE_PROVIDERS.has(provider)) {
    // Managed-routable providers dispatch through the single
    // provider-agnostic `vellum` connection seeded above; no personal row
    // is needed.
    return;
  }

  const connectionName = `${provider}-personal`;
  if (getConnection(db, connectionName)) {
    return;
  }
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
      "Failed to create personal connection during row repair",
    );
    return;
  }
  log.info(
    {
      entry: entryLabel,
      connectionName,
      provider,
      credential: isKeyless ? null : credName,
    },
    "Created personal connection during row repair",
  );
}
