import { describe, expect, mock, test } from "bun:test";

const mockGetApp = mock((_appId: string) => ({
  id: "app-1",
  providerKey: "google",
  clientId: "client-1",
}));

const mockListConnections = mock(() => [
  {
    id: "conn-1",
    providerKey: "google",
    accountInfo: "{\"email\":\"alice@example.com\"}",
    grantedScopes: '["email","profile"]',
    status: "active",
    hasRefreshToken: 1,
    expiresAt: 1735689600000,
    createdAt: 1735689500000,
    updatedAt: 1735689550000,
  },
  {
    id: "conn-2",
    providerKey: "google",
    accountInfo: null,
    grantedScopes: [],
    status: "active",
    hasRefreshToken: 0,
    expiresAt: null,
    createdAt: 1735689601000,
    updatedAt: 1735689602000,
  },
]);

mock.module("../oauth/oauth-store.js", () => ({
  deleteApp: mock(() => Promise.resolve()),
  disconnectOAuthProvider: mock(() => Promise.resolve()),
  getApp: mockGetApp,
  getAppClientSecret: mock(() => Promise.resolve(undefined)),
  getConnection: mock(() => undefined),
  getProvider: mock(() => undefined),
  listApps: mock(() => []),
  listConnections: mockListConnections,
  upsertApp: mock(() =>
    Promise.resolve({
      id: "app-1",
      providerKey: "google",
      clientId: "client-1",
      createdAt: 1735689500000,
      updatedAt: 1735689550000,
    }),
  ),
}));

mock.module("../oauth/connect-orchestrator.js", () => ({
  orchestrateOAuthConnect: mock(() =>
    Promise.resolve({
      success: true,
      deferred: false,
      grantedScopes: [],
      accountInfo: null,
      refreshTokenPresent: false,
    }),
  ),
}));

import { oauthAppsRouteDefinitions } from "../runtime/routes/oauth-apps.js";

const routes = oauthAppsRouteDefinitions();

function getRoute(method: string, endpoint: string) {
  const route = routes.find(
    (r) => r.method === method && r.endpoint === endpoint,
  );
  if (!route) throw new Error(`Route not found: ${method} ${endpoint}`);
  return route;
}

describe("GET /v1/oauth/apps/:appId/connections", () => {
  test("normalizes granted_scopes and has_refresh_token", async () => {
    const req = new Request("http://localhost/v1/oauth/apps/app-1/connections");
    const url = new URL(req.url);
    const res = await getRoute("GET", "oauth/apps/:appId/connections").handler({
      req,
      url,
      server: null as never,
      authContext: null as never,
      params: { appId: "app-1" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connections: Array<{
        granted_scopes: unknown;
        has_refresh_token: unknown;
      }>;
    };

    expect(body.connections[0]?.granted_scopes).toEqual(["email", "profile"]);
    expect(body.connections[0]?.has_refresh_token).toBe(true);
    expect(body.connections[1]?.granted_scopes).toEqual([]);
    expect(body.connections[1]?.has_refresh_token).toBe(false);
  });
});
