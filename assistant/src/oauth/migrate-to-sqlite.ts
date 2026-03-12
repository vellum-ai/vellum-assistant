/**
 * One-time data migration: copy existing OAuth credentials from the
 * credential metadata store + config.json into the new SQLite tables
 * (oauth_app, oauth_connection) and re-key secure store entries.
 *
 * Dual-writes all secure keys (old keys preserved, new keys created)
 * so legacy code paths continue working during the transition period.
 *
 * Guarded by a `memory_checkpoints` row so it runs at most once.
 */

import { getNestedValue, loadRawConfig } from "../config/loader.js";
import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../memory/checkpoints.js";
import { credentialKey } from "../security/credential-key.js";
import {
  deleteSecureKey,
  getSecureKey,
  setSecureKey,
} from "../security/secure-keys.js";
import {
  deleteCredentialMetadata,
  listCredentialMetadata,
} from "../tools/credentials/metadata-store.js";
import { getLogger } from "../util/logger.js";
import {
  createConnection,
  getConnectionByProvider,
  getProvider,
  listApps,
  listConnections,
  updateConnection,
  upsertApp,
} from "./oauth-store.js";

const log = getLogger("migrate-to-sqlite");

const CHECKPOINT_KEY = "migration_oauth_to_sqlite_v1";

/**
 * Migrate existing OAuth credentials from the metadata store to the
 * new SQLite-backed oauth tables. Idempotent: skips if the checkpoint
 * already exists, and skips individual credentials that are already
 * migrated or cannot be migrated (missing provider, missing client_id).
 */
export function migrateOAuthCredentialsToSqlite(): void {
  // Check if this migration has already run
  const checkpoint = getMemoryCheckpoint(CHECKPOINT_KEY);
  if (checkpoint != null) {
    return;
  }

  const allMeta = listCredentialMetadata();

  // Filter to OAuth credentials: field === "access_token" and service starts with "integration:"
  const oauthCredentials = allMeta.filter(
    (m) => m.field === "access_token" && m.service.startsWith("integration:"),
  );

  if (oauthCredentials.length === 0) {
    setMemoryCheckpoint(CHECKPOINT_KEY, "done");
    return;
  }

  log.info(
    { count: oauthCredentials.length },
    "Migrating OAuth credentials to SQLite",
  );

  let raw: Record<string, unknown> | undefined;
  try {
    raw = loadRawConfig();
  } catch {
    // Config not loadable — accountInfo will be unavailable
  }

  for (const meta of oauthCredentials) {
    try {
      migrateOneCredential(meta, raw);
    } catch (err) {
      log.warn(
        { err, service: meta.service },
        "Failed to migrate OAuth credential — skipping",
      );
    }
  }

  setMemoryCheckpoint(CHECKPOINT_KEY, "done");
  log.info("OAuth credential migration to SQLite complete");
}

function migrateOneCredential(
  meta: ReturnType<typeof listCredentialMetadata>[number],
  raw: Record<string, unknown> | undefined,
): void {
  const { service } = meta;

  // (a) Check if an oauth_provider row exists for this service.
  const provider = getProvider(service);
  if (!provider) {
    log.info({ service }, "No OAuth provider registered — skipping migration");
    return;
  }

  // (b) Read oauth2ClientId from the metadata record.
  const clientId = meta.oauth2ClientId;
  if (!clientId) {
    log.info({ service }, "No oauth2ClientId in metadata — skipping migration");
    return;
  }

  // (c) Upsert the oauth_app row.
  const app = upsertApp(service, clientId);

  // (d) Re-key the client secret to the new oauth_app-scoped key format (dual-write).
  const oldClientSecretKey = credentialKey(service, "client_secret");
  const newClientSecretKey = `oauth_app/${app.id}/client_secret`;
  const clientSecret = getSecureKey(oldClientSecretKey);
  if (clientSecret) {
    setSecureKey(newClientSecretKey, clientSecret);
    // Keep old key (dual-write)
  }

  // (e) Check if an active oauth_connection already exists for this provider.
  const existingConn = getConnectionByProvider(service);
  if (existingConn) {
    log.info({ service }, "Active OAuth connection already exists — skipping");
    return;
  }

  // (f) Create the connection with data from the metadata record.
  const conn = createConnection({
    oauthAppId: app.id,
    providerKey: service,
    grantedScopes: meta.grantedScopes ?? [],
    expiresAt: meta.expiresAt,
    hasRefreshToken: meta.hasRefreshToken ?? false,
  });

  // (g) Read accountInfo from config.json and set on the connection.
  if (raw) {
    const accountInfo = (getNestedValue(
      raw,
      `integrations.${service}.accountInfo`,
    ) ??
      // Fallback: legacy config path used before the namespace migration
      getNestedValue(raw, `integrations.accountInfo.${service}`)) as
      | string
      | undefined;

    if (accountInfo) {
      updateConnection(conn.id, { accountInfo });
    }
  }

  // (h) Re-key access_token: credential/{service}/access_token -> oauth_connection/{conn.id}/access_token
  const oldAccessTokenKey = credentialKey(service, "access_token");
  const newAccessTokenKey = `oauth_connection/${conn.id}/access_token`;
  const accessToken = getSecureKey(oldAccessTokenKey);
  if (accessToken) {
    setSecureKey(newAccessTokenKey, accessToken);
    // Keep old key (dual-write)
  }

  // (i) Re-key refresh_token: credential/{service}/refresh_token -> oauth_connection/{conn.id}/refresh_token
  const oldRefreshTokenKey = credentialKey(service, "refresh_token");
  const newRefreshTokenKey = `oauth_connection/${conn.id}/refresh_token`;
  const refreshToken = getSecureKey(oldRefreshTokenKey);
  if (refreshToken) {
    setSecureKey(newRefreshTokenKey, refreshToken);
    // Keep old key (dual-write)
  }

  log.info({ service, connectionId: conn.id }, "Migrated OAuth credential");
}

// ---------------------------------------------------------------------------
// Phase 2: Clean up legacy secure keys that were dual-written during migration
// ---------------------------------------------------------------------------

const CLEANUP_CHECKPOINT_KEY = "migration_cleanup_legacy_oauth_keys_v1";

/**
 * Delete legacy secure key paths (`credential/{service}/...`) for OAuth
 * credentials that have been migrated to the SQLite-backed tables. Also
 * removes the corresponding `CredentialMetadata` records for OAuth services
 * so the metadata store no longer tracks them.
 *
 * Idempotent: checkpoint-guarded, and individual key deletions gracefully
 * skip keys that are already missing.
 */
export function cleanupLegacyOAuthKeys(): void {
  const checkpoint = getMemoryCheckpoint(CLEANUP_CHECKPOINT_KEY);
  if (checkpoint != null) {
    return;
  }

  // (a) For each oauth_connection, delete legacy access_token and refresh_token keys.
  const connections = listConnections();
  for (const conn of connections) {
    const { providerKey } = conn;
    try {
      const legacyAccessKey = credentialKey(providerKey, "access_token");
      deleteSecureKey(legacyAccessKey);

      const legacyRefreshKey = credentialKey(providerKey, "refresh_token");
      deleteSecureKey(legacyRefreshKey);
    } catch (err) {
      log.warn(
        { err, providerKey },
        "Failed to delete legacy connection keys — skipping",
      );
    }
  }

  // (b) For each oauth_app, delete the legacy client_secret key.
  const apps = listApps();
  for (const app of apps) {
    const { providerKey } = app;
    try {
      const legacyClientSecretKey = credentialKey(providerKey, "client_secret");
      deleteSecureKey(legacyClientSecretKey);
    } catch (err) {
      log.warn(
        { err, providerKey },
        "Failed to delete legacy app key — skipping",
      );
    }
  }

  // (c) Delete CredentialMetadata records for OAuth services.
  // Collect unique provider keys from connections (these are the OAuth services).
  const oauthServices = new Set<string>();
  for (const conn of connections) {
    oauthServices.add(conn.providerKey);
  }
  for (const app of apps) {
    oauthServices.add(app.providerKey);
  }

  for (const service of oauthServices) {
    try {
      deleteCredentialMetadata(service, "access_token");
    } catch (err) {
      log.warn(
        { err, service },
        "Failed to delete legacy access_token metadata — skipping",
      );
    }
  }

  if (connections.length > 0 || apps.length > 0) {
    log.info(
      { connections: connections.length, apps: apps.length },
      "Cleaned up legacy OAuth secure keys and metadata",
    );
  }

  setMemoryCheckpoint(CLEANUP_CHECKPOINT_KEY, "done");
}
