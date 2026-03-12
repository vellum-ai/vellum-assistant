import type { DrizzleDb } from "../db-connection.js";

/**
 * OAuth provider, app, and connection tables.
 * Creates tables in FK-dependency order: providers → apps → connections.
 */
export function createOAuthTables(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS oauth_providers (
      provider_key TEXT PRIMARY KEY,
      auth_url TEXT NOT NULL,
      token_url TEXT NOT NULL,
      token_endpoint_auth_method TEXT,
      userinfo_url TEXT,
      base_url TEXT,
      default_scopes TEXT NOT NULL DEFAULT '[]',
      scope_policy TEXT NOT NULL DEFAULT '{}',
      extra_params TEXT,
      callback_transport TEXT,
      loopback_port INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS oauth_apps (
      id TEXT PRIMARY KEY,
      provider_key TEXT NOT NULL REFERENCES oauth_providers(provider_key),
      client_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS oauth_connections (
      id TEXT PRIMARY KEY,
      oauth_app_id TEXT NOT NULL REFERENCES oauth_apps(id),
      provider_key TEXT NOT NULL,
      account_info TEXT,
      granted_scopes TEXT NOT NULL DEFAULT '[]',
      expires_at INTEGER,
      has_refresh_token INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      label TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_apps_provider_client ON oauth_apps(provider_key, client_id)`,
  );

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_oauth_connections_provider_key ON oauth_connections(provider_key)`,
  );
}
