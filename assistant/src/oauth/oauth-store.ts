/**
 * CRUD store for OAuth providers, apps, and connections.
 *
 * Backed by Drizzle + SQLite. All JSON fields (default_scopes, scope_policy,
 * extra_params, granted_scopes, metadata) are stored as serialized JSON strings.
 */

import {
  deleteOAuthTokens,
  oauthAppClientSecretPath,
  oauthConnectionAccessTokenPath,
  type SecureKeyBackend,
} from "@vellumai/credential-storage";
import { and, desc, eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb, rawChanges } from "../memory/db.js";
import {
  oauthApps,
  oauthConnections,
  oauthProviders,
} from "../memory/schema/oauth.js";
import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("oauth-store");

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type OAuthProviderRow = typeof oauthProviders.$inferSelect;
export type OAuthAppRow = typeof oauthApps.$inferSelect;
export type OAuthConnectionRow = typeof oauthConnections.$inferSelect;

// ---------------------------------------------------------------------------
// Provider operations
// ---------------------------------------------------------------------------

/**
 * Seed well-known provider profiles into the database. Uses INSERT … ON
 * CONFLICT DO UPDATE so that implementation fields (authUrl, tokenUrl,
 * tokenEndpointAuthMethod, extraParams, callbackTransport, pingUrl)
 * propagate to existing installations on every startup, while
 * user-customizable fields (defaultScopes, scopePolicy, userinfoUrl,
 * baseUrl) are only written on the initial insert.
 */
export function seedProviders(
  profiles: Array<{
    providerKey: string;
    authUrl: string;
    tokenUrl: string;
    tokenEndpointAuthMethod?: string;
    userinfoUrl?: string;
    pingUrl?: string;
    baseUrl?: string;
    defaultScopes: string[];
    scopePolicy: Record<string, unknown>;
    extraParams?: Record<string, string>;
    callbackTransport?: string;
  }>,
): void {
  const db = getDb();
  const now = Date.now();
  for (const p of profiles) {
    const authUrl = p.authUrl;
    const tokenUrl = p.tokenUrl;
    const tokenEndpointAuthMethod = p.tokenEndpointAuthMethod ?? null;
    const userinfoUrl = p.userinfoUrl ?? null;
    const pingUrl = p.pingUrl ?? null;
    const baseUrl = p.baseUrl ?? null;
    const defaultScopes = JSON.stringify(p.defaultScopes);
    const scopePolicy = JSON.stringify(p.scopePolicy);
    const extraParams = p.extraParams ? JSON.stringify(p.extraParams) : null;
    const callbackTransport = p.callbackTransport ?? null;

    db.insert(oauthProviders)
      .values({
        providerKey: p.providerKey,
        authUrl,
        tokenUrl,
        tokenEndpointAuthMethod,
        userinfoUrl,
        baseUrl,
        defaultScopes,
        scopePolicy,
        extraParams,
        callbackTransport,
        pingUrl,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: oauthProviders.providerKey,
        set: {
          authUrl,
          tokenUrl,
          tokenEndpointAuthMethod,
          extraParams,
          callbackTransport,
          pingUrl,
          updatedAt: now,
        },
      })
      .run();
  }
}

/** Look up a provider by its primary key. */
export function getProvider(providerKey: string): OAuthProviderRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(oauthProviders)
    .where(eq(oauthProviders.providerKey, providerKey))
    .get();
}

/** Return all registered providers. */
export function listProviders(): OAuthProviderRow[] {
  const db = getDb();
  return db.select().from(oauthProviders).all();
}

/**
 * Register a new provider (for dynamic registration). Throws if the
 * provider_key already exists.
 */
export function registerProvider(params: {
  providerKey: string;
  authUrl: string;
  tokenUrl: string;
  tokenEndpointAuthMethod?: string;
  userinfoUrl?: string;
  pingUrl?: string;
  baseUrl?: string;
  defaultScopes: string[];
  scopePolicy: Record<string, unknown>;
  extraParams?: Record<string, string>;
  callbackTransport?: string;
}): OAuthProviderRow {
  const db = getDb();
  const now = Date.now();

  const existing = getProvider(params.providerKey);
  if (existing) {
    throw new Error(`OAuth provider already exists: ${params.providerKey}`);
  }

  const row = {
    providerKey: params.providerKey,
    authUrl: params.authUrl,
    tokenUrl: params.tokenUrl,
    tokenEndpointAuthMethod: params.tokenEndpointAuthMethod ?? null,
    userinfoUrl: params.userinfoUrl ?? null,
    baseUrl: params.baseUrl ?? null,
    defaultScopes: JSON.stringify(params.defaultScopes),
    scopePolicy: JSON.stringify(params.scopePolicy),
    extraParams: params.extraParams ? JSON.stringify(params.extraParams) : null,
    callbackTransport: params.callbackTransport ?? null,
    pingUrl: params.pingUrl ?? null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(oauthProviders).values(row).run();

  return row;
}

// ---------------------------------------------------------------------------
// App operations
// ---------------------------------------------------------------------------

/**
 * Insert or return an existing app by (provider_key, client_id).
 * Generates a UUID on insert.
 */
export async function upsertApp(
  providerKey: string,
  clientId: string,
  clientSecretOpts?: {
    clientSecretValue?: string;
    clientSecretCredentialPath?: string;
  },
): Promise<OAuthAppRow> {
  const { clientSecretValue, clientSecretCredentialPath } =
    clientSecretOpts ?? {};

  if (clientSecretValue && clientSecretCredentialPath) {
    throw new Error(
      "Cannot provide both clientSecretValue and clientSecretCredentialPath",
    );
  }

  const defaultCredPath = (appId: string) => oauthAppClientSecretPath(appId);

  // Verify the credential path points to an existing secret.
  if (clientSecretCredentialPath) {
    const existing = await getSecureKeyAsync(clientSecretCredentialPath);
    if (existing === undefined) {
      throw new Error(
        `No secret found at credential path: ${clientSecretCredentialPath}`,
      );
    }
  }

  const db = getDb();

  const existingRow = db
    .select()
    .from(oauthApps)
    .where(
      and(
        eq(oauthApps.providerKey, providerKey),
        eq(oauthApps.clientId, clientId),
      ),
    )
    .get();

  if (existingRow) {
    if (clientSecretValue) {
      const stored = await setSecureKeyAsync(
        existingRow.clientSecretCredentialPath,
        clientSecretValue,
      );
      if (!stored) {
        throw new Error("Failed to store client_secret in secure storage");
      }
    }
    if (clientSecretCredentialPath) {
      db.update(oauthApps)
        .set({
          clientSecretCredentialPath,
          updatedAt: Date.now(),
        })
        .where(eq(oauthApps.id, existingRow.id))
        .run();
      return db
        .select()
        .from(oauthApps)
        .where(eq(oauthApps.id, existingRow.id))
        .get()!;
    }
    return existingRow;
  }

  const now = Date.now();
  const id = uuid();
  const credPath = clientSecretCredentialPath ?? defaultCredPath(id);

  const row = {
    id,
    providerKey,
    clientId,
    clientSecretCredentialPath: credPath,
    createdAt: now,
    updatedAt: now,
  };

  // Insert the DB row first so that a failed insert doesn't leave an
  // orphaned secret in secure storage.
  db.insert(oauthApps).values(row).run();

  if (clientSecretValue) {
    const stored = await setSecureKeyAsync(credPath, clientSecretValue);
    if (!stored) {
      // Roll back the just-inserted row to avoid an orphaned app pointing
      // at a non-existent client_secret in secure storage.
      db.delete(oauthApps).where(eq(oauthApps.id, id)).run();
      throw new Error("Failed to store client_secret in secure storage");
    }
  }

  return row;
}

/** Look up an app by its primary key. */
export function getApp(id: string): OAuthAppRow | undefined {
  const db = getDb();
  return db.select().from(oauthApps).where(eq(oauthApps.id, id)).get();
}

/** Look up an app by (provider_key, client_id). */
export function getAppByProviderAndClientId(
  providerKey: string,
  clientId: string,
): OAuthAppRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(oauthApps)
    .where(
      and(
        eq(oauthApps.providerKey, providerKey),
        eq(oauthApps.clientId, clientId),
      ),
    )
    .get();
}

/**
 * Get the most recently created app for a provider.
 * Returns undefined if no app exists for this provider.
 */
export function getMostRecentAppByProvider(
  providerKey: string,
): OAuthAppRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(oauthApps)
    .where(eq(oauthApps.providerKey, providerKey))
    .orderBy(desc(oauthApps.createdAt))
    .limit(1)
    .get();
}

/** Return all OAuth apps. */
export function listApps(): OAuthAppRow[] {
  const db = getDb();
  return db.select().from(oauthApps).all();
}

/** Delete an app by ID. Cleans up the client_secret from secure storage. Returns true if a row was deleted. */
export async function deleteApp(id: string): Promise<boolean> {
  const db = getDb();

  const app = db.select().from(oauthApps).where(eq(oauthApps.id, id)).get();
  if (!app) return false;

  // Delete the DB row first so that if it fails (e.g. FK constraint from
  // existing connections), the secret in secure storage remains intact.
  db.delete(oauthApps).where(eq(oauthApps.id, id)).run();

  const result = await deleteSecureKeyAsync(app.clientSecretCredentialPath);
  if (result === "error") {
    // Throw (rather than returning "error" like disconnectOAuthProvider) because
    // the DB row is already deleted above. The caller should surface this to the
    // user so they can retry or manually clean up the orphaned secret.
    throw new Error(
      `Deleted app ${id} but failed to remove client_secret from secure storage`,
    );
  }

  return true;
}

// ---------------------------------------------------------------------------
// Connection operations
// ---------------------------------------------------------------------------

/**
 * Create a new OAuth connection. Generates a UUID and sets status='active'.
 * `metadata` is an optional JSON object for provider-specific token response data.
 */
export function createConnection(params: {
  oauthAppId: string;
  providerKey: string;
  accountInfo?: string;
  grantedScopes: string[];
  expiresAt?: number;
  hasRefreshToken: boolean;
  label?: string;
  metadata?: Record<string, unknown>;
  /** Override the creation timestamp. Useful in tests to ensure deterministic ordering. */
  createdAt?: number;
}): OAuthConnectionRow {
  const db = getDb();
  const now = params.createdAt ?? Date.now();
  const id = uuid();

  const row = {
    id,
    oauthAppId: params.oauthAppId,
    providerKey: params.providerKey,
    accountInfo: params.accountInfo ?? null,
    grantedScopes: JSON.stringify(params.grantedScopes),
    expiresAt: params.expiresAt ?? null,
    hasRefreshToken: params.hasRefreshToken ? 1 : 0,
    status: "active" as const,
    label: params.label ?? null,
    metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(oauthConnections).values(row).run();

  return row;
}

/** Look up a connection by its primary key. */
export function getConnection(id: string): OAuthConnectionRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(oauthConnections)
    .where(eq(oauthConnections.id, id))
    .get();
}

/**
 * Get the most recent active connection for a provider.
 * When `clientId` is provided, only connections linked to the matching app are considered.
 * Returns undefined if no active connection exists.
 */
export function getConnectionByProvider(
  providerKey: string,
  clientId?: string,
): OAuthConnectionRow | undefined {
  const db = getDb();

  if (clientId) {
    const app = getAppByProviderAndClientId(providerKey, clientId);
    if (!app) return undefined;
    return db
      .select()
      .from(oauthConnections)
      .where(
        and(
          eq(oauthConnections.providerKey, providerKey),
          eq(oauthConnections.oauthAppId, app.id),
          eq(oauthConnections.status, "active"),
        ),
      )
      .orderBy(desc(oauthConnections.createdAt), sql`rowid DESC`)
      .limit(1)
      .get();
  }

  return db
    .select()
    .from(oauthConnections)
    .where(
      and(
        eq(oauthConnections.providerKey, providerKey),
        eq(oauthConnections.status, "active"),
      ),
    )
    .orderBy(desc(oauthConnections.createdAt), sql`rowid DESC`)
    .limit(1)
    .get();
}

/**
 * Get the active connection for a provider matching a specific account.
 * Falls back to getConnectionByProvider when accountInfo is undefined.
 */
export function getConnectionByProviderAndAccount(
  providerKey: string,
  accountInfo?: string,
): OAuthConnectionRow | undefined {
  if (!accountInfo) return getConnectionByProvider(providerKey);

  const db = getDb();
  return db
    .select()
    .from(oauthConnections)
    .where(
      and(
        eq(oauthConnections.providerKey, providerKey),
        eq(oauthConnections.accountInfo, accountInfo),
        eq(oauthConnections.status, "active"),
      ),
    )
    .orderBy(desc(oauthConnections.createdAt), sql`rowid DESC`)
    .limit(1)
    .get();
}

/**
 * Get ALL active connections for a provider (supports multi-account).
 */
export function listActiveConnectionsByProvider(
  providerKey: string,
): OAuthConnectionRow[] {
  const db = getDb();
  return db
    .select()
    .from(oauthConnections)
    .where(
      and(
        eq(oauthConnections.providerKey, providerKey),
        eq(oauthConnections.status, "active"),
      ),
    )
    .orderBy(desc(oauthConnections.createdAt), sql`rowid DESC`)
    .all();
}

/**
 * Check whether a provider has a usable OAuth connection: an active row in the
 * database AND a corresponding access token in secure storage.
 *
 * This guards against the edge case where the connection row was created/updated
 * but the secure-key write for the access token failed, which would make
 * `resolveOAuthConnection()` throw at usage time.
 */
export async function isProviderConnected(
  providerKey: string,
): Promise<boolean> {
  const conn = getConnectionByProvider(providerKey);
  if (!conn || conn.status !== "active") return false;
  return (
    (await getSecureKeyAsync(oauthConnectionAccessTokenPath(conn.id))) !==
    undefined
  );
}

/**
 * Update fields on an existing connection. Returns true if a row was updated.
 */
export function updateConnection(
  id: string,
  updates: Partial<{
    oauthAppId: string;
    accountInfo: string;
    grantedScopes: string[];
    /** Pass `null` to explicitly clear a stale expiresAt in the DB. */
    expiresAt: number | null;
    hasRefreshToken: boolean;
    status: string;
    label: string;
    metadata: Record<string, unknown>;
  }>,
): boolean {
  const db = getDb();
  const now = Date.now();

  // Build the set clause, serializing JSON fields and converting booleans.
  // For expiresAt, null means "clear the column" so we check for undefined
  // explicitly rather than truthiness.
  const set: Record<string, unknown> = { updatedAt: now };
  if (updates.oauthAppId !== undefined) set.oauthAppId = updates.oauthAppId;
  if (updates.accountInfo !== undefined) set.accountInfo = updates.accountInfo;
  if (updates.grantedScopes !== undefined)
    set.grantedScopes = JSON.stringify(updates.grantedScopes);
  if (updates.expiresAt !== undefined) set.expiresAt = updates.expiresAt;
  if (updates.hasRefreshToken !== undefined)
    set.hasRefreshToken = updates.hasRefreshToken ? 1 : 0;
  if (updates.status !== undefined) set.status = updates.status;
  if (updates.label !== undefined) set.label = updates.label;
  if (updates.metadata !== undefined)
    set.metadata = JSON.stringify(updates.metadata);

  db.update(oauthConnections).set(set).where(eq(oauthConnections.id, id)).run();

  return rawChanges() > 0;
}

/** List connections, optionally filtered by provider key and/or client ID. */
export function listConnections(
  providerKey?: string,
  clientId?: string,
): OAuthConnectionRow[] {
  const db = getDb();

  let rows: OAuthConnectionRow[];
  if (providerKey) {
    rows = db
      .select()
      .from(oauthConnections)
      .where(eq(oauthConnections.providerKey, providerKey))
      .all();
  } else {
    rows = db.select().from(oauthConnections).all();
  }

  if (clientId) {
    const matchingAppIds = new Set(
      db
        .select({ id: oauthApps.id })
        .from(oauthApps)
        .where(eq(oauthApps.clientId, clientId))
        .all()
        .map((a) => a.id),
    );
    return rows.filter((r) => matchingAppIds.has(r.oauthAppId));
  }

  return rows;
}

/** Delete a connection by ID. Returns true if a row was deleted. */
export function deleteConnection(id: string): boolean {
  const db = getDb();
  db.delete(oauthConnections).where(eq(oauthConnections.id, id)).run();
  return rawChanges() > 0;
}

// ---------------------------------------------------------------------------
// Disconnect (full cleanup)
// ---------------------------------------------------------------------------

/**
 * Fully disconnect an OAuth provider: delete the new-format secure keys
 * (access_token and refresh_token) and remove the connection row from SQLite.
 *
 * When `connectionId` is provided, disconnects that specific connection
 * (useful for multi-account providers). Otherwise falls back to the most
 * recent active connection.
 *
 * Returns `"disconnected"` if a connection was found and cleaned up,
 * `"not-found"` if no active connection existed for the given provider,
 * or `"error"` if secure key deletion failed (connection row is preserved
 * to avoid orphaning secrets).
 */
export async function disconnectOAuthProvider(
  providerKey: string,
  clientId?: string,
  connectionId?: string,
): Promise<"disconnected" | "not-found" | "error"> {
  const conn = connectionId
    ? getConnection(connectionId)
    : getConnectionByProvider(providerKey, clientId);
  if (!conn) return "not-found";

  // Wrap the assistant's secure-key functions into the SecureKeyBackend
  // interface expected by the shared deleteOAuthTokens helper.
  const backend: SecureKeyBackend = {
    get: (key: string) => getSecureKeyAsync(key),
    set: (key: string, value: string) => setSecureKeyAsync(key, value),
    delete: (key: string) => deleteSecureKeyAsync(key),
    list: async () => [],
  };

  const { accessTokenResult, refreshTokenResult } = await deleteOAuthTokens(
    backend,
    conn.id,
  );

  if (accessTokenResult === "error" || refreshTokenResult === "error") {
    // Return "error" (rather than throwing like deleteApp) so the connection row
    // is preserved. This avoids orphaning secrets in secure storage — the caller
    // can retry later and the row acts as a pointer to the keys that still need
    // cleanup. In deleteApp the DB row is already gone, so throwing is the only
    // way to surface the failure.
    log.warn(
      {
        providerKey,
        connectionId: conn.id,
        accessTokenResult,
        refreshTokenResult,
      },
      "Failed to delete OAuth secure keys — skipping connection row deletion to avoid orphaning secrets",
    );
    return "error";
  }

  deleteConnection(conn.id);

  return "disconnected";
}
