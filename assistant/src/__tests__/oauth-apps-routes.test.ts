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
    accountInfo: '{"email":"alice@example.com"}',
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
  getProvider: mock((providerKey: string) =>
    providerKey === "google"
      ? {
          providerKey: "google",
          displayName: "Google",
          description: "Google OAuth provider",
          dashboardUrl: "https://console.cloud.google.com/apis/credentials",
          clientIdPlaceholder: null,
          requiresClientSecret: 1,
          managedServiceConfigKey: "google-oauth",
          authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          tokenEndpointAuthMethod: null,
          userinfoUrl: null,
          baseUrl: null,
          defaultScopes: "[]",
          scopePolicy: "[]",
          extraParams: null,
          callbackTransport: null,
          pingUrl: null,
          pingMethod: null,
          pingHeaders: null,
          pingBody: null,
          loopbackPort: null,
          injectionTemplates: null,
          appType: null,
          setupNotes: null,
          identityUrl: null,
          identityMethod: null,
          identityHeaders: null,
          identityBody: null,
          identityFormat: null,
          identityOkField: null,
          featureFlag: null,
          createdAt: 1735689500000,
          updatedAt: 1735689550000,
        }
      : undefined,
  ),
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

describe("GET /v1/oauth/apps", () => {
  test("returns provider metadata with correct types when provider exists", async () => {
    const req = new Request(
      "http://localhost/v1/oauth/apps?provider_key=google",
    );
    const url = new URL(req.url);
    const res = await getRoute("GET", "oauth/apps").handler({
      req,
      url,
      server: null as never,
      authContext: null as never,
      params: {},
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      provider: {
        provider_key: string;
        display_name: string | null;
        description: string | null;
        dashboard_url: string | null;
        client_id_placeholder: string | null;
        requires_client_secret: boolean;
        supports_managed_mode: boolean;
      } | null;
      apps: unknown[];
    };

    expect(body.provider).not.toBeNull();
    expect(body.provider!.provider_key).toBe("google");
    expect(body.provider!.display_name).toBe("Google");
    expect(body.provider!.description).toBe("Google OAuth provider");

    // requires_client_secret is normalised to a boolean by the shared serializer
    expect(body.provider!.requires_client_secret).toBe(true);
    expect(typeof body.provider!.requires_client_secret).toBe("boolean");

    // supports_managed_mode is derived from the presence of managedServiceConfigKey
    expect(body.provider!.supports_managed_mode).toBe(true);
  });

  test("returns null provider when provider does not exist", async () => {
    const req = new Request(
      "http://localhost/v1/oauth/apps?provider_key=unknown",
    );
    const url = new URL(req.url);
    const res = await getRoute("GET", "oauth/apps").handler({
      req,
      url,
      server: null as never,
      authContext: null as never,
      params: {},
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      provider: unknown;
      apps: unknown[];
    };

    expect(body.provider).toBeNull();
  });
});
