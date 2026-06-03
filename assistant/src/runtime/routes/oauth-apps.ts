/**
 * Route handlers for OAuth app and connection CRUD.
 *
 * Provides endpoints for managing user-supplied OAuth apps (e.g. "your own"
 * Google client credentials) and their connections. All endpoints are
 * bearer-token authenticated via the standard runtime auth middleware.
 */

import { z } from "zod";

import { orchestrateOAuthConnect } from "../../oauth/connect-orchestrator.js";
import {
  deleteApp,
  disconnectOAuthProvider,
  getApp,
  getAppByProviderAndClientId,
  getAppClientSecret,
  getConnection,
  getMostRecentAppByProvider,
  getProvider,
  listApps,
  listConnections,
  upsertApp,
} from "../../oauth/oauth-store.js";
import { serializeProviderSummary } from "../../oauth/provider-serializer.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import { oauthProviderSummarySchema } from "./oauth-providers.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

function parseGrantedScopes(
  grantedScopes: string | string[] | null | undefined,
): string[] {
  if (Array.isArray(grantedScopes)) {
    return grantedScopes.filter(
      (scope): scope is string => typeof scope === "string",
    );
  }

  if (typeof grantedScopes !== "string" || grantedScopes.trim() === "") {
    return [];
  }

  try {
    const parsed = JSON.parse(grantedScopes) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((scope): scope is string => typeof scope === "string");
  } catch {
    return [];
  }
}

function normalizeHasRefreshToken(
  hasRefreshToken: boolean | number | null | undefined,
): boolean {
  return hasRefreshToken === true || hasRefreshToken === 1;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function formatAppRow(row: {
  id: string;
  provider: string;
  clientId: string;
  createdAt: number;
  updatedAt: number;
}) {
  return {
    id: row.id,
    provider_key: row.provider,
    client_id: row.clientId,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function handleListApps({ queryParams = {} }: RouteHandlerArgs) {
  const provider = queryParams.provider_key;
  if (!provider) {
    throw new BadRequestError("provider_key query parameter is required");
  }

  const allApps = listApps();
  const filtered = allApps.filter((row) => row.provider === provider);

  const providerRow = getProvider(provider);
  const providerSummary = providerRow
    ? serializeProviderSummary(providerRow)
    : null;

  return {
    provider: providerSummary,
    apps: filtered.map(formatAppRow),
  };
}

function handleGetApp({ queryParams = {} }: RouteHandlerArgs) {
  const { id, provider, client_id } = queryParams;

  let row;
  if (id) {
    row = getApp(id);
  } else if (provider && client_id) {
    row = getAppByProviderAndClientId(provider, client_id);
  } else if (provider) {
    row = getMostRecentAppByProvider(provider);
  } else {
    throw new BadRequestError(
      "Provide id, provider, or provider + client_id query parameters",
    );
  }

  if (!row) {
    const lookup = id
      ? `id=${id}`
      : provider && client_id
        ? `provider=${provider}, client_id=${client_id}`
        : `provider=${provider}`;
    throw new NotFoundError(`No app found for ${lookup}`);
  }

  return { app: formatAppRow(row) };
}

async function handleUpsertApp({ body = {} }: RouteHandlerArgs) {
  const b = body as Record<string, unknown>;
  const providerKey = b.provider_key as string | undefined;
  const clientId = b.client_id as string | undefined;

  if (!providerKey || !clientId) {
    throw new BadRequestError("provider_key and client_id are required");
  }

  const clientSecretOpts = b.client_secret
    ? { clientSecretValue: b.client_secret as string }
    : b.client_secret_credential_path
      ? {
          clientSecretCredentialPath: b.client_secret_credential_path as string,
        }
      : undefined;

  const row = await upsertApp(providerKey, clientId, clientSecretOpts);

  return { app: formatAppRow(row) };
}

async function handleCreateApp({ body = {} }: RouteHandlerArgs) {
  const { provider_key, client_id, client_secret } = body as {
    provider_key?: string;
    client_id?: string;
    client_secret?: string;
  };

  if (
    !provider_key ||
    typeof provider_key !== "string" ||
    !client_id ||
    typeof client_id !== "string" ||
    !client_secret ||
    typeof client_secret !== "string"
  ) {
    throw new BadRequestError(
      "provider_key, client_id, and client_secret are required non-empty strings",
    );
  }

  const provider = getProvider(provider_key);
  if (!provider) {
    throw new NotFoundError(
      `No OAuth provider registered for "${provider_key}"`,
    );
  }

  const app = await upsertApp(provider_key, client_id, {
    clientSecretValue: client_secret,
  });

  return {
    app: {
      id: app.id,
      provider_key: app.provider,
      client_id: app.clientId,
      created_at: app.createdAt,
      updated_at: app.updatedAt,
    },
  };
}

async function handleDeleteApp({ pathParams = {} }: RouteHandlerArgs) {
  const app = getApp(pathParams.id ?? "");
  if (!app) {
    throw new NotFoundError(`OAuth app not found: ${pathParams.id}`);
  }

  const connections = listConnections(app.provider, app.clientId);
  for (const conn of connections) {
    await disconnectOAuthProvider(app.provider, app.clientId, conn.id);
  }

  await deleteApp(pathParams.id ?? "");

  return { ok: true };
}

function handleListConnections({ pathParams = {} }: RouteHandlerArgs) {
  const app = getApp(pathParams.appId ?? "");
  if (!app) {
    throw new NotFoundError(`OAuth app not found: ${pathParams.appId}`);
  }

  const connections = listConnections(app.provider, app.clientId);

  return {
    connections: connections.map((row) => ({
      id: row.id,
      provider_key: row.provider,
      account_info: row.accountInfo,
      granted_scopes: parseGrantedScopes(row.grantedScopes),
      status: row.status,
      has_refresh_token: normalizeHasRefreshToken(row.hasRefreshToken),
      expires_at: row.expiresAt,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    })),
  };
}

async function handleDeleteConnection({ pathParams = {} }: RouteHandlerArgs) {
  const conn = getConnection(pathParams.id ?? "");
  if (!conn) {
    throw new NotFoundError(`OAuth connection not found: ${pathParams.id}`);
  }

  const result = await disconnectOAuthProvider(
    conn.provider,
    undefined,
    conn.id,
  );
  if (result === "error") {
    throw new InternalError(
      "Failed to clean up connection tokens. The connection was not removed.",
    );
  }

  return { ok: true };
}

async function handleConnectApp({ pathParams = {}, body }: RouteHandlerArgs) {
  const app = getApp(pathParams.appId ?? "");
  if (!app) {
    throw new NotFoundError(`OAuth app not found: ${pathParams.appId}`);
  }

  const parsed = (body ?? {}) as {
    scopes?: string[];
    callback_transport?: "loopback" | "gateway";
  };

  if (
    parsed.callback_transport !== undefined &&
    parsed.callback_transport !== "loopback" &&
    parsed.callback_transport !== "gateway"
  ) {
    throw new BadRequestError(
      'callback_transport must be "loopback" or "gateway"',
    );
  }

  const clientSecret = await getAppClientSecret(app);

  const result = await orchestrateOAuthConnect({
    service: app.provider,
    clientId: app.clientId,
    clientSecret,
    requestedScopes: parsed.scopes,
    callbackTransport: parsed.callback_transport ?? "loopback",
    isInteractive: false,
  });

  if (result.success && result.deferred) {
    return {
      auth_url: result.authorizeUrl,
      state: result.state,
    };
  }

  if (!result.success) {
    throw new InternalError(result.error);
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Custom OAuth app registration (snake_case wire shape from `formatAppRow`). */
const oauthAppSchema = z.object({
  id: z.string(),
  provider_key: z.string(),
  client_id: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});

/** OAuth connection linked to a custom OAuth app. */
const oauthAppConnectionSchema = z.object({
  id: z.string(),
  provider_key: z.string(),
  account_info: z.string().nullable(),
  granted_scopes: z.array(z.string()),
  status: z.string(),
  has_refresh_token: z.boolean(),
  expires_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

const oauthAppCredentialsSchema = z.object({
  provider_key: z.string(),
  client_id: z.string(),
  client_secret: z.string(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "oauth_apps_get",
    endpoint: "oauth/apps",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List OAuth apps",
    description: "List OAuth apps filtered by provider_key.",
    tags: ["oauth"],
    queryParams: [
      {
        name: "provider_key",
        type: "string",
        required: true,
        description: "OAuth provider key to filter by",
      },
    ],
    responseBody: z.object({
      provider: oauthProviderSummarySchema.nullable(),
      apps: z.array(oauthAppSchema),
    }),
    handler: handleListApps,
  },
  {
    operationId: "oauth_apps_by_query_get",
    endpoint: "oauth/apps/lookup",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get OAuth app",
    description:
      "Look up a single OAuth app by ID, provider + client_id, or provider (most recent).",
    tags: ["oauth"],
    queryParams: [
      {
        name: "id",
        type: "string",
        description: "App UUID",
      },
      {
        name: "provider",
        type: "string",
        description: "Provider key",
      },
      {
        name: "client_id",
        type: "string",
        description: "OAuth client ID (requires provider)",
      },
    ],
    responseBody: z.object({ app: oauthAppSchema }),
    handler: handleGetApp,
  },
  {
    operationId: "oauth_apps_upsert",
    endpoint: "oauth/apps/upsert",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Upsert OAuth app",
    description:
      "Create or return an existing OAuth app registration. Updates client secret if provided.",
    tags: ["oauth"],
    requestBody: z.object({
      provider_key: z.string(),
      client_id: z.string(),
      client_secret: z.string().optional(),
      client_secret_credential_path: z.string().optional(),
    }),
    responseBody: z.object({ app: oauthAppSchema }),
    handler: handleUpsertApp,
  },
  {
    operationId: "oauth_apps_post",
    endpoint: "oauth/apps",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Create OAuth app",
    description: "Register a new OAuth app with client credentials.",
    tags: ["oauth"],
    requestBody: oauthAppCredentialsSchema,
    responseBody: z.object({ app: oauthAppSchema }),
    responseStatus: "201",
    handler: handleCreateApp,
  },
  {
    operationId: "oauth_apps_delete",
    endpoint: "oauth/apps/:id",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete OAuth app",
    description: "Delete an OAuth app and disconnect all its connections.",
    tags: ["oauth"],
    responseBody: z.object({ ok: z.boolean() }),
    handler: handleDeleteApp,
  },
  {
    operationId: "oauth_apps_connections_get",
    endpoint: "oauth/apps/:appId/connections",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List OAuth connections",
    description: "List connections for an OAuth app.",
    tags: ["oauth"],
    responseBody: z.object({
      connections: z.array(oauthAppConnectionSchema),
    }),
    handler: handleListConnections,
  },
  {
    operationId: "oauth_connections_delete",
    endpoint: "oauth/connections/:id",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Disconnect OAuth connection",
    description: "Disconnect a single OAuth connection.",
    tags: ["oauth"],
    responseBody: z.object({ ok: z.boolean() }),
    handler: handleDeleteConnection,
  },
  {
    operationId: "oauth_apps_connect_post",
    endpoint: "oauth/apps/:appId/connect",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Start OAuth connect",
    description: "Start an OAuth connect flow for an app.",
    tags: ["oauth"],
    requestBody: z.object({
      scopes: z.array(z.string()).optional(),
      callback_transport: z.enum(["loopback", "gateway"]).optional(),
    }),
    responseBody: z.union([
      z.object({ auth_url: z.string(), state: z.string() }),
      z.object({ ok: z.literal(true) }),
    ]),
    handler: handleConnectApp,
  },
];
