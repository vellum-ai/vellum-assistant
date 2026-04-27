/**
 * Route handlers for OAuth app and connection CRUD.
 *
 * Provides endpoints for managing user-supplied OAuth apps (e.g. "your own"
 * Google client credentials) and their connections. All endpoints are
 * bearer-token authenticated via the standard runtime auth middleware.
 */

import { orchestrateOAuthConnect } from "../../oauth/connect-orchestrator.js";
import {
  deleteApp,
  disconnectOAuthProvider,
  getApp,
  getAppClientSecret,
  getConnection,
  getProvider,
  listApps,
  listConnections,
  upsertApp,
} from "../../oauth/oauth-store.js";
import { serializeProviderSummary } from "../../oauth/provider-serializer.js";
import {
  BadRequestError,
  InternalError,
  NotFoundError,
} from "./errors.js";
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
    apps: filtered.map((row) => ({
      id: row.id,
      provider_key: row.provider,
      client_id: row.clientId,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    })),
  };
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
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "oauth_apps_get",
    endpoint: "oauth/apps",
    method: "GET",
    summary: "List OAuth apps",
    description: "List OAuth apps filtered by provider_key.",
    tags: ["oauth"],
    requirePolicyEnforcement: true,
    queryParams: [
      {
        name: "provider_key",
        type: "string",
        required: true,
        description: "OAuth provider key to filter by",
      },
    ],
    handler: handleListApps,
  },
  {
    operationId: "oauth_apps_post",
    endpoint: "oauth/apps",
    method: "POST",
    policyKey: "oauth/apps.create",
    summary: "Create OAuth app",
    description: "Register a new OAuth app with client credentials.",
    tags: ["oauth"],
    requirePolicyEnforcement: true,
    responseStatus: "201",
    handler: handleCreateApp,
  },
  {
    operationId: "oauth_apps_delete",
    endpoint: "oauth/apps/:id",
    method: "DELETE",
    policyKey: "oauth/apps.delete",
    summary: "Delete OAuth app",
    description:
      "Delete an OAuth app and disconnect all its connections.",
    tags: ["oauth"],
    requirePolicyEnforcement: true,
    handler: handleDeleteApp,
  },
  {
    operationId: "oauth_apps_connections_get",
    endpoint: "oauth/apps/:appId/connections",
    method: "GET",
    summary: "List OAuth connections",
    description: "List connections for an OAuth app.",
    tags: ["oauth"],
    requirePolicyEnforcement: true,
    handler: handleListConnections,
  },
  {
    operationId: "oauth_connections_delete",
    endpoint: "oauth/connections/:id",
    method: "DELETE",
    summary: "Disconnect OAuth connection",
    description: "Disconnect a single OAuth connection.",
    tags: ["oauth"],
    requirePolicyEnforcement: true,
    handler: handleDeleteConnection,
  },
  {
    operationId: "oauth_apps_connect_post",
    endpoint: "oauth/apps/:appId/connect",
    method: "POST",
    summary: "Start OAuth connect",
    description: "Start an OAuth connect flow for an app.",
    tags: ["oauth"],
    requirePolicyEnforcement: true,
    handler: handleConnectApp,
  },
];
