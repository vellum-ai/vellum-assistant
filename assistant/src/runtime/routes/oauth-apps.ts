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
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

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

/**
 * Build route definitions for OAuth app and connection CRUD endpoints.
 */
export function oauthAppsRouteDefinitions(): RouteDefinition[] {
  return [
    // GET /v1/oauth/apps — List apps filtered by provider_key query param.
    {
      endpoint: "oauth/apps",
      method: "GET",
      handler: ({ url }) => {
        const providerKey = url.searchParams.get("provider_key");
        if (!providerKey) {
          return httpError(
            "BAD_REQUEST",
            "provider_key query parameter is required",
            400,
          );
        }

        const allApps = listApps();
        const filtered = allApps.filter(
          (row) => row.providerKey === providerKey,
        );

        const providerRow = getProvider(providerKey);
        const provider = providerRow
          ? {
              provider_key: providerRow.providerKey,
              display_name: providerRow.displayName ?? null,
              description: providerRow.description ?? null,
              dashboard_url: providerRow.dashboardUrl ?? null,
              client_id_placeholder: providerRow.clientIdPlaceholder ?? null,
              requires_client_secret: !!(providerRow.requiresClientSecret ?? 1),
              supports_managed_mode: !!providerRow.managedServiceConfigKey,
            }
          : null;

        return Response.json({
          provider,
          apps: filtered.map((row) => ({
            id: row.id,
            provider_key: row.providerKey,
            client_id: row.clientId,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
          })),
        });
      },
    },

    // POST /v1/oauth/apps — Create an OAuth app.
    {
      endpoint: "oauth/apps",
      method: "POST",
      policyKey: "oauth/apps.create",
      handler: async ({ req }) => {
        const body = (await req.json()) as {
          provider_key?: string;
          client_id?: string;
          client_secret?: string;
        };

        const { provider_key, client_id, client_secret } = body;

        if (
          !provider_key ||
          typeof provider_key !== "string" ||
          !client_id ||
          typeof client_id !== "string" ||
          !client_secret ||
          typeof client_secret !== "string"
        ) {
          return httpError(
            "BAD_REQUEST",
            "provider_key, client_id, and client_secret are required non-empty strings",
            400,
          );
        }

        const provider = getProvider(provider_key);
        if (!provider) {
          return httpError(
            "NOT_FOUND",
            `No OAuth provider registered for "${provider_key}"`,
            404,
          );
        }

        const app = await upsertApp(provider_key, client_id, {
          clientSecretValue: client_secret,
        });

        return Response.json(
          {
            app: {
              id: app.id,
              provider_key: app.providerKey,
              client_id: app.clientId,
              created_at: app.createdAt,
              updated_at: app.updatedAt,
            },
          },
          { status: 201 },
        );
      },
    },

    // DELETE /v1/oauth/apps/:id — Delete an OAuth app.
    {
      endpoint: "oauth/apps/:id",
      method: "DELETE",
      policyKey: "oauth/apps.delete",
      handler: async ({ params }) => {
        const app = getApp(params.id);
        if (!app) {
          return httpError(
            "NOT_FOUND",
            `OAuth app not found: ${params.id}`,
            404,
          );
        }

        // Disconnect all connections for this app first to clean up tokens.
        const connections = listConnections(app.providerKey, app.clientId);
        for (const conn of connections) {
          await disconnectOAuthProvider(app.providerKey, app.clientId, conn.id);
        }

        await deleteApp(params.id);

        return Response.json({ ok: true });
      },
    },

    // GET /v1/oauth/apps/:appId/connections — List connections for an app.
    {
      endpoint: "oauth/apps/:appId/connections",
      method: "GET",
      handler: ({ params }) => {
        const app = getApp(params.appId);
        if (!app) {
          return httpError(
            "NOT_FOUND",
            `OAuth app not found: ${params.appId}`,
            404,
          );
        }

        const connections = listConnections(app.providerKey, app.clientId);

        return Response.json({
          connections: connections.map((row) => ({
            id: row.id,
            provider_key: row.providerKey,
            account_info: row.accountInfo,
            granted_scopes: parseGrantedScopes(row.grantedScopes),
            status: row.status,
            has_refresh_token: normalizeHasRefreshToken(row.hasRefreshToken),
            expires_at: row.expiresAt,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
          })),
        });
      },
    },

    // DELETE /v1/oauth/connections/:id — Disconnect a single connection.
    {
      endpoint: "oauth/connections/:id",
      method: "DELETE",
      handler: async ({ params }) => {
        const conn = getConnection(params.id);
        if (!conn) {
          return httpError(
            "NOT_FOUND",
            `OAuth connection not found: ${params.id}`,
            404,
          );
        }

        const result = await disconnectOAuthProvider(
          conn.providerKey,
          undefined,
          conn.id,
        );
        if (result === "error") {
          return httpError(
            "INTERNAL_ERROR",
            "Failed to clean up connection tokens. The connection was not removed.",
            500,
          );
        }

        return Response.json({ ok: true });
      },
    },

    // POST /v1/oauth/apps/:appId/connect — Start OAuth connect flow.
    {
      endpoint: "oauth/apps/:appId/connect",
      method: "POST",
      handler: async ({ req, params }) => {
        const app = getApp(params.appId);
        if (!app) {
          return httpError(
            "NOT_FOUND",
            `OAuth app not found: ${params.appId}`,
            404,
          );
        }

        let body: { scopes?: string[] } = {};
        try {
          const text = await req.text();
          if (text) {
            body = JSON.parse(text);
          }
        } catch {
          // No body or invalid JSON — use defaults
        }

        const clientSecret = await getAppClientSecret(app);

        const result = await orchestrateOAuthConnect({
          service: app.providerKey,
          clientId: app.clientId,
          clientSecret,
          requestedScopes: body.scopes,
          isInteractive: false,
        });

        if (result.success && result.deferred) {
          return Response.json({
            auth_url: result.authUrl,
            state: result.state,
          });
        }

        if (!result.success) {
          return Response.json({ error: result.error }, { status: 500 });
        }

        // Interactive success (shouldn't happen with isInteractive: false,
        // but handle gracefully)
        return Response.json({ ok: true });
      },
    },
  ];
}
