/**
 * CRUD store for OAuth providers, apps, and connections.
 *
 * Backed by Drizzle + SQLite. All JSON fields (default_scopes, scope_policy,
 * extra_params, granted_scopes, metadata) are stored as serialized JSON strings.
 */

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
  getSecureKey,
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
 * CONFLICT DO UPDATE so that corrections to seed data (e.g. a fixed baseUrl)
 * propagate to existing installations on the next startup.
 */
export function seedProviders(
  profiles: Array<{
    providerKey: string;
    authUrl: string;
    tokenUrl: string;
    tokenEndpointAuthMethod?: string;
    userinfoUrl?: string;
    baseUrl?: string;
    defaultScopes: string[];
    scopePolicy: Record<string, unknown>;
    extraParams?: Record<string, string>;
    callbackTransport?: string;
    loopbackPort?: number;
  }>,
): void {
  const db = getDb();
  const now = Date.now();
  for (const p of profiles) {
    const authUrl = p.authUrl;
    const tokenUrl = p.tokenUrl;
    const tokenEndpointAuthMethod = p.tokenEndpointAuthMethod ?? null;
    const userinfoUrl = p.userinfoUrl ?? null;
    const baseUrl = p.baseUrl ?? null;
    const defaultScopes = JSON.stringify(p.defaultScopes);
    const scopePolicy = JSON.stringify(p.scopePolicy);
    const extraParams = p.extraParams ? JSON.stringify(p.extraParams) : null;
    const callbackTransport = p.callbackTransport ?? null;
    const loopbackPort = p.loopbackPort ?? null;

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
        loopbackPort,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: oauthProviders.providerKey,
        set: {
          authUrl,
          tokenUrl,
          tokenEndpointAuthMethod,
          userinfoUrl,
          baseUrl,
          defaultScopes,
          scopePolicy,
          extraParams,
          callbackTransport,
          loopbackPort,
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
  baseUrl?: string;
  defaultScopes: string[];
  scopePolicy: Record<string, unknown>;
  extraParams?: Record<string, string>;
  callbackTransport?: string;
  loopbackPort?: number;
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
    loopbackPort: params.loopbackPort ?? null,
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
  clientSecret?: string,
): Promise<OAuthAppRow> {
  const db = getDb();

  const existing = db
    .select()
    .from(oauthApps)
    .where(
      and(
        eq(oauthApps.providerKey, providerKey),
        eq(oauthApps.clientId, clientId),
      ),
    )
    .get();

  if (existing) {
    if (clientSecret) {
      const stored = await setSecureKeyAsync(
        `oauth_app/${existing.id}/client_secret`,
        clientSecret,
      );
      if (!stored) {
        throw new Error("Failed to store client_secret in secure storage");
      }
    }
    return existing;
  }

  const now = Date.now();
  const id = uuid();
  const row = {
    id,
    providerKey,
    clientId,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(oauthApps).values(row).run();

  if (clientSecret) {
    const stored = await setSecureKeyAsync(
      `oauth_app/${id}/client_secret`,
      clientSecret,
    );
    if (!stored) {
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
  const result = await deleteSecureKeyAsync(`oauth_app/${id}/client_secret`);
  if (result === "error") {
    log.warn(
      { appId: id },
      "Failed to delete client_secret from secure storage — skipping app deletion to avoid orphaning secrets",
    );
    return false;
  }

  const db = getDb();
  db.delete(oauthApps).where(eq(oauthApps.id, id)).run();
  return rawChanges() > 0;
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
 * Returns undefined if no active connection exists.
 */
export function getConnectionByProvider(
  providerKey: string,
): OAuthConnectionRow | undefined {
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
    .limit(1)
    .get();
}

/**
 * Check whether a provider has a usable OAuth connection: an active row in the
 * database AND a corresponding access token in secure storage.
 *
 * This guards against the edge case where the connection row was created/updated
 * but the secure-key write for the access token failed, which would make
 * `resolveOAuthConnection()` throw at usage time.
 */
export function isProviderConnected(providerKey: string): boolean {
  const conn = getConnectionByProvider(providerKey);
  if (!conn || conn.status !== "active") return false;
  return getSecureKey(`oauth_connection/${conn.id}/access_token`) !== undefined;
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

/** List connections, optionally filtered by provider key. */
export function listConnections(providerKey?: string): OAuthConnectionRow[] {
  const db = getDb();

  if (providerKey) {
    return db
      .select()
      .from(oauthConnections)
      .where(eq(oauthConnections.providerKey, providerKey))
      .all();
  }

  return db.select().from(oauthConnections).all();
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
 * Returns `"disconnected"` if a connection was found and cleaned up,
 * `"not-found"` if no active connection existed for the given provider,
 * or `"error"` if secure key deletion failed (connection row is preserved
 * to avoid orphaning secrets).
 */
export async function disconnectOAuthProvider(
  providerKey: string,
): Promise<"disconnected" | "not-found" | "error"> {
  const conn = getConnectionByProvider(providerKey);
  if (!conn) return "not-found";

  const r1 = await deleteSecureKeyAsync(
    `oauth_connection/${conn.id}/access_token`,
  );
  const r2 = await deleteSecureKeyAsync(
    `oauth_connection/${conn.id}/refresh_token`,
  );

  if (r1 === "error" || r2 === "error") {
    log.warn(
      {
        providerKey,
        connectionId: conn.id,
        accessTokenResult: r1,
        refreshTokenResult: r2,
      },
      "Failed to delete OAuth secure keys — skipping connection row deletion to avoid orphaning secrets",
    );
    return "error";
  }

  deleteConnection(conn.id);

  return "disconnected";
}
