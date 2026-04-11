/**
 * Shared serialization utilities for OAuth provider rows.
 *
 * Used by both the CLI (providers commands) and runtime API endpoints to
 * produce consistent, parsed representations of provider rows stored in
 * the database.
 */

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";
import type { OAuthProviderRow } from "./oauth-store.js";

/**
 * Full serialized representation of an OAuth provider row.
 *
 * JSON string fields are parsed into their native types, boolean/integer
 * fields are normalised to booleans, timestamps are ISO 8601 strings,
 * and a computed `supportsManagedMode` flag is included.
 */
export type SerializedProvider = ReturnType<typeof serializeProvider> &
  Record<string, unknown>;

/**
 * Lightweight summary projection of an OAuth provider, suitable for API
 * list responses where full detail is not needed. All keys are snake_case
 * to match the HTTP API convention.
 */
export interface SerializedProviderSummary {
  provider_key: string;
  display_name: string | null;
  description: string | null;
  dashboard_url: string | null;
  client_id_placeholder: string | null;
  requires_client_secret: boolean;
  logo_url: string | null;
  supports_managed_mode: boolean;
  feature_flag: string | null;
}

/**
 * Serialize a full provider row from the database into a parsed object.
 *
 * JSON string columns are parsed, boolean/integer fields are normalised to
 * booleans, and timestamps are converted to ISO 8601 strings. An optional
 * `redirectUri` override can be supplied by the caller (e.g. the CLI,
 * which resolves the redirect URI from config).
 *
 * Returns `undefined` when `row` is `undefined`, and `null` when `row` is
 * `null`, preserving the caller's nullable semantics.
 */
export function serializeProvider(
  row: OAuthProviderRow | null | undefined,
  options?: { redirectUri?: string | null; config?: AssistantConfig },
): ReturnType<typeof _serializeProvider> | null | undefined {
  if (row === undefined) return undefined;
  if (row === null) return null;
  return _serializeProvider(row, options);
}

function _serializeProvider(
  row: OAuthProviderRow,
  options?: { redirectUri?: string | null; config?: AssistantConfig },
) {
  // Destructure the renamed Drizzle TS-side fields out of the row so they
  // do not leak into the spread below. The wire format intentionally keeps
  // the legacy camelCase keys (`providerKey`, `authUrl`, `tokenUrl`,
  // `displayName`, `extraParams`) so existing CLI script consumers and any
  // other clients that parse this output don't break. The renamed fields
  // are emitted explicitly under their old names instead.
  const {
    provider,
    authorizeUrl,
    tokenExchangeUrl,
    displayLabel,
    authorizeParams,
    ...rest
  } = row;
  return {
    ...rest,
    providerKey: provider,
    authUrl: authorizeUrl,
    tokenUrl: tokenExchangeUrl,
    refreshUrl: row.refreshUrl ?? null,
    displayName: displayLabel ?? null,
    description: row.description ?? null,
    dashboardUrl: row.dashboardUrl ?? null,
    logoUrl: row.logoUrl ?? null,
    clientIdPlaceholder: row.clientIdPlaceholder ?? null,
    requiresClientSecret: !!(row.requiresClientSecret ?? 1),
    supportsManagedMode: isManagedModeEnabled(row, options?.config),
    defaultScopes: row.defaultScopes ? JSON.parse(row.defaultScopes) : [],
    scopePolicy: row.scopePolicy ? JSON.parse(row.scopePolicy) : {},
    scopeSeparator: row.scopeSeparator,
    extraParams: authorizeParams ? JSON.parse(authorizeParams) : null,
    pingHeaders: row.pingHeaders ? JSON.parse(row.pingHeaders) : null,
    pingBody: row.pingBody ? JSON.parse(row.pingBody) : null,
    revokeUrl: row.revokeUrl || null,
    revokeBodyTemplate: row.revokeBodyTemplate
      ? JSON.parse(row.revokeBodyTemplate)
      : null,
    loopbackPort: row.loopbackPort ?? null,
    injectionTemplates: row.injectionTemplates
      ? JSON.parse(row.injectionTemplates)
      : null,
    appType: row.appType ?? null,
    setupNotes: row.setupNotes ? JSON.parse(row.setupNotes) : null,
    identityUrl: row.identityUrl ?? null,
    identityMethod: row.identityMethod ?? null,
    identityHeaders: row.identityHeaders
      ? JSON.parse(row.identityHeaders)
      : null,
    identityBody: row.identityBody ? JSON.parse(row.identityBody) : null,
    identityResponsePaths: row.identityResponsePaths
      ? JSON.parse(row.identityResponsePaths)
      : null,
    identityFormat: row.identityFormat ?? null,
    identityOkField: row.identityOkField ?? null,
    featureFlag: row.featureFlag ?? null,
    redirectUri:
      options?.redirectUri !== undefined ? options.redirectUri : null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/**
 * Return a lightweight snake_case summary of a provider row, suitable for
 * embedding in API list responses.
 *
 * Returns `null` when `row` is nullish.
 */
export function serializeProviderSummary(
  row: OAuthProviderRow | null | undefined,
  config?: AssistantConfig,
): SerializedProviderSummary | null {
  if (!row) return null;
  return {
    provider_key: row.provider,
    display_name: row.displayLabel ?? null,
    description: row.description ?? null,
    dashboard_url: row.dashboardUrl ?? null,
    client_id_placeholder: row.clientIdPlaceholder ?? null,
    requires_client_secret: !!(row.requiresClientSecret ?? 1),
    logo_url: row.logoUrl ?? null,
    supports_managed_mode: isManagedModeEnabled(row, config),
    feature_flag: row.featureFlag ?? null,
  };
}

/**
 * A provider supports managed mode when it has a managedServiceConfigKey
 * and either has no feature flag or the flag is enabled.
 */
function isManagedModeEnabled(
  row: OAuthProviderRow,
  config?: AssistantConfig,
): boolean {
  if (!row.managedServiceConfigKey) return false;
  if (!row.featureFlag || !config) return true;
  return isAssistantFeatureFlagEnabled(row.featureFlag, config);
}
