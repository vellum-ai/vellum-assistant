import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const oauthProviders = sqliteTable("oauth_providers", {
  providerKey: text("provider_key").primaryKey(),
  authUrl: text("auth_url").notNull(),
  tokenUrl: text("token_url").notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
  userinfoUrl: text("userinfo_url"),
  baseUrl: text("base_url"),
  defaultScopes: text("default_scopes").notNull().default("[]"),
  scopePolicy: text("scope_policy").notNull().default("{}"),
  extraParams: text("extra_params"),
  callbackTransport: text("callback_transport"),
  pingUrl: text("ping_url"),
  pingMethod: text("ping_method"),
  pingHeaders: text("ping_headers"),
  pingBody: text("ping_body"),
  managedServiceConfigKey: text("managed_service_config_key"),
  displayName: text("display_name"),
  description: text("description"),
  dashboardUrl: text("dashboard_url"),
  clientIdPlaceholder: text("client_id_placeholder"),
  requiresClientSecret: integer("requires_client_secret").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const oauthApps = sqliteTable(
  "oauth_apps",
  {
    id: text("id").primaryKey(),
    providerKey: text("provider_key")
      .notNull()
      .references(() => oauthProviders.providerKey),
    clientId: text("client_id").notNull(),
    clientSecretCredentialPath: text("client_secret_credential_path").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_oauth_apps_provider_client").on(
      table.providerKey,
      table.clientId,
    ),
  ],
);

export const oauthConnections = sqliteTable(
  "oauth_connections",
  {
    id: text("id").primaryKey(),
    oauthAppId: text("oauth_app_id")
      .notNull()
      .references(() => oauthApps.id),
    providerKey: text("provider_key").notNull(),
    accountInfo: text("account_info"),
    grantedScopes: text("granted_scopes").notNull().default("[]"),
    expiresAt: integer("expires_at"),
    hasRefreshToken: integer("has_refresh_token").notNull().default(0),
    status: text("status").notNull().default("active"),
    label: text("label"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_oauth_connections_provider_key").on(table.providerKey),
  ],
);
