import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const oauthProviders = sqliteTable("oauth_providers", {
  provider: text("provider_key").primaryKey(),
  authorizeUrl: text("auth_url").notNull(),
  tokenExchangeUrl: text("token_url").notNull(),
  refreshUrl: text("refresh_url"),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method")
    .notNull()
    .default("client_secret_post"),
  userinfoUrl: text("userinfo_url"),
  baseUrl: text("base_url"),
  defaultScopes: text("default_scopes").notNull().default("[]"),
  scopePolicy: text("scope_policy").notNull().default("{}"),
  scopeSeparator: text("scope_separator").notNull().default(" "),
  authorizeParams: text("extra_params"),
  pingUrl: text("ping_url"),
  pingMethod: text("ping_method"),
  pingHeaders: text("ping_headers"),
  pingBody: text("ping_body"),
  revokeUrl: text("revoke_url"),
  revokeBodyTemplate: text("revoke_body_template"),
  managedServiceConfigKey: text("managed_service_config_key"),
  displayLabel: text("display_name"),
  description: text("description"),
  dashboardUrl: text("dashboard_url"),
  clientIdPlaceholder: text("client_id_placeholder"),
  logoUrl: text("logo_url"),
  requiresClientSecret: integer("requires_client_secret").notNull().default(1),
  loopbackPort: integer("loopback_port"),
  injectionTemplates: text("injection_templates"),
  appType: text("app_type"),
  setupNotes: text("setup_notes"),
  identityUrl: text("identity_url"),
  identityMethod: text("identity_method"),
  identityHeaders: text("identity_headers"),
  identityBody: text("identity_body"),
  identityResponsePaths: text("identity_response_paths"),
  identityFormat: text("identity_format"),
  identityOkField: text("identity_ok_field"),
  featureFlag: text("feature_flag"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const oauthApps = sqliteTable(
  "oauth_apps",
  {
    id: text("id").primaryKey(),
    provider: text("provider_key")
      .notNull()
      .references(() => oauthProviders.provider),
    clientId: text("client_id").notNull(),
    clientSecretCredentialPath: text("client_secret_credential_path").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_oauth_apps_provider_client").on(
      table.provider,
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
    provider: text("provider_key").notNull(),
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
  (table) => [index("idx_oauth_connections_provider_key").on(table.provider)],
);
