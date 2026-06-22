/**
 * Route handlers for OAuth provider CRUD.
 *
 * Provides endpoints for querying, registering, updating, and deleting OAuth
 * provider configurations. All endpoints are bearer-token authenticated via
 * the standard runtime auth middleware.
 */

import { z } from "zod";

import { loadConfig } from "../../config/loader.js";
import { getOAuthCallbackUrl } from "../../inbound/public-ingress-urls.js";
import {
  deleteApp,
  deleteConnection,
  deleteProvider,
  disconnectOAuthProvider,
  getProvider,
  listApps,
  listConnections,
  listProviders,
  registerProvider,
  updateProvider,
} from "../../oauth/oauth-store.js";
import {
  serializeProvider,
  serializeProviderSummary,
} from "../../oauth/provider-serializer.js";
import { isProviderVisible } from "../../oauth/provider-visibility.js";
import { SEEDED_PROVIDER_KEYS } from "../../oauth/seed-providers.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOOPBACK_CALLBACK_PATH = "/oauth/callback";

function resolveRedirectUri(loopbackPort: number | null): string | null {
  if (!loopbackPort) {
    return "http://localhost:<dynamic>/oauth/callback";
  }
  return `http://localhost:${loopbackPort}${LOOPBACK_CALLBACK_PATH}`;
}

function serializeProviderFull(row: ReturnType<typeof getProvider>) {
  if (!row) return null;
  return serializeProvider(row, {
    redirectUri: resolveRedirectUri(row.loopbackPort),
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleListProviders({ queryParams = {} }: RouteHandlerArgs) {
  const rows = listProviders();
  const config = loadConfig();
  const visibleRows = rows.filter((r) => isProviderVisible(r, config));
  let serialized = visibleRows
    .map((row) => serializeProviderSummary(row))
    .filter((s): s is NonNullable<typeof s> => s !== null);

  const supportsManagedMode = queryParams.supports_managed_mode;
  if (supportsManagedMode === "true") {
    serialized = serialized.filter((p) => p.supports_managed_mode);
  } else if (supportsManagedMode === "false") {
    serialized = serialized.filter((p) => !p.supports_managed_mode);
  }

  return { providers: serialized };
}

function handleGetProvider({ pathParams = {} }: RouteHandlerArgs) {
  const { providerKey } = pathParams;
  const row = getProvider(providerKey);
  if (!row) {
    throw new NotFoundError(
      `No OAuth provider registered for "${providerKey}"`,
    );
  }

  const config = loadConfig();
  if (!isProviderVisible(row, config)) {
    throw new NotFoundError(
      `No OAuth provider registered for "${providerKey}"`,
    );
  }

  let oauthCallbackUrl: string | null = null;
  try {
    oauthCallbackUrl = getOAuthCallbackUrl(config);
  } catch {
    // Ingress not configured or disabled — callback URL unavailable
  }

  return {
    provider: serializeProviderFull(row),
    oauth_callback_url: oauthCallbackUrl,
  };
}

function handleRegisterProvider({ body = {} }: RouteHandlerArgs) {
  const b = body as Record<string, unknown>;
  const providerKey = b.provider_key as string | undefined;
  const authUrl = b.auth_url as string | undefined;
  const tokenUrl = b.token_url as string | undefined;

  if (!providerKey || !authUrl || !tokenUrl) {
    throw new BadRequestError(
      "provider_key, auth_url, and token_url are required",
    );
  }

  try {
    const row = registerProvider({
      provider: providerKey,
      authorizeUrl: authUrl,
      tokenExchangeUrl: tokenUrl,
      refreshUrl: (b.refresh_url as string) ?? undefined,
      baseUrl: (b.base_url as string) ?? undefined,
      userinfoUrl: (b.userinfo_url as string) ?? undefined,
      defaultScopes: (b.default_scopes as string[]) ?? [],
      availableScopes: b.available_scopes as
        | string
        | Array<{ scope: string; description?: string }>
        | undefined,
      scopeSeparator: (b.scope_separator as string) ?? undefined,
      tokenEndpointAuthMethod:
        (b.token_endpoint_auth_method as string) ?? undefined,
      tokenExchangeBodyFormat:
        (b.token_exchange_body_format as string) ?? undefined,
      pingUrl: (b.ping_url as string) ?? undefined,
      pingMethod: (b.ping_method as string) ?? undefined,
      pingHeaders: (b.ping_headers as Record<string, string>) ?? undefined,
      pingBody: b.ping_body ?? undefined,
      revokeUrl: (b.revoke_url as string) ?? undefined,
      revokeBodyTemplate:
        (b.revoke_body_template as Record<string, string>) ?? undefined,
      displayLabel: (b.display_name as string) ?? undefined,
      description: (b.description as string) ?? undefined,
      dashboardUrl: (b.dashboard_url as string) ?? undefined,
      logoUrl: (b.logo_url as string | null) ?? undefined,
      clientIdPlaceholder: (b.client_id_placeholder as string) ?? undefined,
      requiresClientSecret:
        b.requires_client_secret !== undefined
          ? (b.requires_client_secret as boolean)
            ? 1
            : 0
          : undefined,
      loopbackPort: (b.loopback_port as number) ?? undefined,
      injectionTemplates:
        (b.injection_templates as Array<{
          hostPattern: string;
          injectionType: string;
          headerName: string;
          valuePrefix: string;
        }>) ?? undefined,
      appType: (b.app_type as string) ?? undefined,
      identityUrl: (b.identity_url as string) ?? undefined,
      identityMethod: (b.identity_method as string) ?? undefined,
      identityHeaders:
        (b.identity_headers as Record<string, string>) ?? undefined,
      identityBody: b.identity_body ?? undefined,
      identityResponsePaths:
        (b.identity_response_paths as string[]) ?? undefined,
      identityFormat: (b.identity_format as string) ?? undefined,
      identityOkField: (b.identity_ok_field as string) ?? undefined,
      setupNotes: (b.setup_notes as string[]) ?? undefined,
    });

    return { provider: serializeProviderFull(row) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists")) {
      throw new ConflictError(msg);
    }
    throw new InternalError(msg);
  }
}

function handleUpdateProvider({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  const { providerKey } = pathParams;
  const existing = getProvider(providerKey);
  if (!existing) {
    throw new NotFoundError(
      `No OAuth provider registered for "${providerKey}"`,
    );
  }

  if (!isProviderVisible(existing, loadConfig())) {
    throw new NotFoundError(
      `No OAuth provider registered for "${providerKey}"`,
    );
  }

  if (SEEDED_PROVIDER_KEYS.has(providerKey)) {
    throw new BadRequestError(
      `Cannot update built-in provider "${providerKey}". Built-in providers are managed by the system.`,
    );
  }

  const b = body as Record<string, unknown>;
  const params: Record<string, unknown> = {};

  if (b.auth_url !== undefined) params.authorizeUrl = b.auth_url;
  if (b.token_url !== undefined) params.tokenExchangeUrl = b.token_url;
  if (b.refresh_url !== undefined) params.refreshUrl = b.refresh_url;
  if (b.base_url !== undefined) params.baseUrl = b.base_url;
  if (b.userinfo_url !== undefined) params.userinfoUrl = b.userinfo_url;
  if (b.default_scopes !== undefined) params.defaultScopes = b.default_scopes;
  if (b.available_scopes !== undefined)
    params.availableScopes = b.available_scopes;
  if (b.scope_separator !== undefined)
    params.scopeSeparator = b.scope_separator;
  if (b.token_endpoint_auth_method !== undefined)
    params.tokenEndpointAuthMethod = b.token_endpoint_auth_method;
  if (b.token_exchange_body_format !== undefined)
    params.tokenExchangeBodyFormat = b.token_exchange_body_format;
  if (b.ping_url !== undefined) params.pingUrl = b.ping_url;
  if (b.ping_method !== undefined) params.pingMethod = b.ping_method;
  if (b.ping_headers !== undefined) params.pingHeaders = b.ping_headers;
  if (b.ping_body !== undefined) params.pingBody = b.ping_body;
  if (b.revoke_url !== undefined) params.revokeUrl = b.revoke_url;
  if (b.revoke_body_template !== undefined)
    params.revokeBodyTemplate = b.revoke_body_template;
  if (b.display_name !== undefined) params.displayLabel = b.display_name;
  if (b.description !== undefined) params.description = b.description;
  if (b.dashboard_url !== undefined) params.dashboardUrl = b.dashboard_url;
  if (b.logo_url !== undefined) params.logoUrl = b.logo_url;
  if (b.client_id_placeholder !== undefined)
    params.clientIdPlaceholder = b.client_id_placeholder;
  if (b.requires_client_secret !== undefined)
    params.requiresClientSecret = b.requires_client_secret;
  if (b.loopback_port !== undefined) params.loopbackPort = b.loopback_port;
  if (b.injection_templates !== undefined)
    params.injectionTemplates = b.injection_templates;
  if (b.app_type !== undefined) params.appType = b.app_type;
  if (b.identity_url !== undefined) params.identityUrl = b.identity_url;
  if (b.identity_method !== undefined)
    params.identityMethod = b.identity_method;
  if (b.identity_headers !== undefined)
    params.identityHeaders = b.identity_headers;
  if (b.identity_body !== undefined) params.identityBody = b.identity_body;
  if (b.identity_response_paths !== undefined)
    params.identityResponsePaths = b.identity_response_paths;
  if (b.identity_format !== undefined)
    params.identityFormat = b.identity_format;
  if (b.identity_ok_field !== undefined)
    params.identityOkField = b.identity_ok_field;
  if (b.setup_notes !== undefined) params.setupNotes = b.setup_notes;

  if (Object.keys(params).length === 0) {
    throw new BadRequestError("No fields to update");
  }

  const row = updateProvider(providerKey, params);
  return { provider: serializeProviderFull(row) };
}

async function handleDeleteProvider({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  const { providerKey } = pathParams;
  const existing = getProvider(providerKey);
  if (!existing) {
    throw new NotFoundError(
      `No OAuth provider registered for "${providerKey}"`,
    );
  }

  if (!isProviderVisible(existing, loadConfig())) {
    throw new NotFoundError(
      `No OAuth provider registered for "${providerKey}"`,
    );
  }

  const force = (body as Record<string, unknown>).force === true;

  const dependentApps = listApps().filter((a) => a.provider === providerKey);
  const dependentConnections = listConnections(providerKey);
  const appCount = dependentApps.length;
  const connCount = dependentConnections.length;

  if ((appCount > 0 || connCount > 0) && !force) {
    throw new BadRequestError(
      `Cannot delete provider "${providerKey}": ${appCount} app(s) and ${connCount} connection(s) depend on it. Set force=true to cascade-delete.`,
    );
  }

  // Cascade-delete connections first, then apps, then the provider
  for (const conn of dependentConnections) {
    const result = await disconnectOAuthProvider(
      providerKey,
      undefined,
      conn.id as string,
    );
    if (result === "error") {
      deleteConnection(conn.id);
    }
  }
  for (const app of dependentApps) {
    await deleteApp(app.id);
  }
  deleteProvider(providerKey);

  return {
    ok: true,
    deleted: { provider: 1, apps: appCount, connections: connCount },
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/**
 * Lightweight summary projection of an OAuth provider returned by the catalog
 * list endpoint. Mirrors `SerializedProviderSummary` from the provider
 * serializer (snake_case to match the HTTP API convention).
 */
export const oauthProviderSummarySchema = z.object({
  provider_key: z.string(),
  display_name: z.string().nullable(),
  description: z.string().nullable(),
  dashboard_url: z.string().nullable(),
  client_id_placeholder: z.string().nullable(),
  requires_client_secret: z.boolean(),
  logo_url: z.string().nullable(),
  supports_managed_mode: z.boolean(),
  managed_service_is_paid: z.boolean(),
  feature_flag: z.string().nullable(),
});

/**
 * Response for the single-provider detail endpoint. The `provider` field is the
 * full serialized provider configuration — an open-ended, admin-defined object
 * whose keys depend on the stored row (parsed JSON blobs, identity templates,
 * and forwarded columns), so it is intentionally typed as an open record rather
 * than a closed schema. `oauth_callback_url` is the ingress callback URL the
 * web UI consumes (null when ingress is not configured).
 */
export const oauthProviderDetailSchema = z.object({
  provider: z.record(z.string(), z.unknown()),
  oauth_callback_url: z.string().nullable(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "oauth_providers_get",
    endpoint: "oauth/providers",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List OAuth providers",
    description: "List all registered OAuth providers with optional filtering.",
    tags: ["oauth"],
    handler: handleListProviders,
    queryParams: [
      {
        name: "supports_managed_mode",
        schema: { type: "string" },
        description: "Filter by managed mode support (true/false)",
      },
    ],
    responseBody: z.object({
      providers: z.array(oauthProviderSummarySchema),
    }),
  },
  {
    operationId: "oauth_providers_by_providerKey_get",
    endpoint: "oauth/providers/:providerKey",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get OAuth provider",
    description: "Get a single OAuth provider by key.",
    tags: ["oauth"],
    handler: handleGetProvider,
    responseBody: oauthProviderDetailSchema,
  },
  {
    operationId: "oauth_providers_post",
    endpoint: "oauth/providers",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Register OAuth provider",
    description: "Register a new OAuth provider configuration.",
    tags: ["oauth"],
    responseStatus: "201",
    handler: handleRegisterProvider,
  },
  {
    operationId: "oauth_providers_by_providerKey_patch",
    endpoint: "oauth/providers/:providerKey",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update OAuth provider",
    description: "Update an existing custom OAuth provider configuration.",
    tags: ["oauth"],
    handler: handleUpdateProvider,
  },
  {
    operationId: "oauth_providers_by_providerKey_delete",
    endpoint: "oauth/providers/:providerKey",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete OAuth provider",
    description:
      "Delete a custom OAuth provider and optionally cascade-delete its apps and connections.",
    tags: ["oauth"],
    handler: handleDeleteProvider,
  },
];
