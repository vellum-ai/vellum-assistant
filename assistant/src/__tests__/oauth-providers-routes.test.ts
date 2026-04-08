import { describe, expect, mock, test } from "bun:test";

const mockListProviders = mock(() => [
  {
    provider: "google",
    displayLabel: "Google",
    description: "Google OAuth provider",
    dashboardUrl: "https://console.cloud.google.com/apis/credentials",
    clientIdPlaceholder: null,
    requiresClientSecret: 1,
    managedServiceConfigKey: "google-oauth",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenExchangeUrl: "https://oauth2.googleapis.com/token",
    refreshUrl: null,
    tokenEndpointAuthMethod: "client_secret_post",
    userinfoUrl: null,
    baseUrl: null,
    defaultScopes: "[]",
    scopePolicy: "[]",
    scopeSeparator: null,
    authorizeParams: null,

    pingUrl: null,
    pingMethod: null,
    pingHeaders: null,
    pingBody: null,
    revokeUrl: null,
    revokeBodyTemplate: null,
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
    identityResponsePaths: null,
    featureFlag: null,
    createdAt: 1735689500000,
    updatedAt: 1735689550000,
  },
  {
    provider: "github",
    displayLabel: "GitHub",
    description: "GitHub OAuth provider",
    dashboardUrl: "https://github.com/settings/developers",
    clientIdPlaceholder: null,
    requiresClientSecret: 1,
    managedServiceConfigKey: null,
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenExchangeUrl: "https://github.com/login/oauth/access_token",
    refreshUrl: null,
    tokenEndpointAuthMethod: "client_secret_post",
    userinfoUrl: null,
    baseUrl: null,
    defaultScopes: "[]",
    scopePolicy: "[]",
    scopeSeparator: null,
    authorizeParams: null,

    pingUrl: null,
    pingMethod: null,
    pingHeaders: null,
    pingBody: null,
    revokeUrl: null,
    revokeBodyTemplate: null,
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
    identityResponsePaths: null,
    featureFlag: null,
    createdAt: 1735689600000,
    updatedAt: 1735689650000,
  },
]);

const mockGetProvider = mock((provider: string) => {
  const all = mockListProviders();
  return all.find((p) => p.provider === provider) ?? undefined;
});

mock.module("../oauth/oauth-store.js", () => ({
  listProviders: mockListProviders,
  getProvider: mockGetProvider,
}));

import { oauthProvidersRouteDefinitions } from "../runtime/routes/oauth-providers.js";

const routes = oauthProvidersRouteDefinitions();

function getRoute(method: string, endpoint: string) {
  const route = routes.find(
    (r) => r.method === method && r.endpoint === endpoint,
  );
  if (!route) throw new Error(`Route not found: ${method} ${endpoint}`);
  return route;
}

describe("GET /v1/oauth/providers", () => {
  test("returns all providers with correct summary shape", async () => {
    const req = new Request("http://localhost/v1/oauth/providers");
    const url = new URL(req.url);
    const res = await getRoute("GET", "oauth/providers").handler({
      req,
      url,
      server: null as never,
      authContext: null as never,
      params: {},
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{
        provider_key: string;
        display_name: string | null;
        description: string | null;
        dashboard_url: string | null;
        client_id_placeholder: string | null;
        requires_client_secret: boolean;
        supports_managed_mode: boolean;
      }>;
    };

    expect(body.providers).toHaveLength(2);
    expect(body.providers[0]!.provider_key).toBe("google");
    expect(body.providers[1]!.provider_key).toBe("github");
  });

  test("response shape matches serializeProviderSummary output (snake_case keys)", async () => {
    const req = new Request("http://localhost/v1/oauth/providers");
    const url = new URL(req.url);
    const res = await getRoute("GET", "oauth/providers").handler({
      req,
      url,
      server: null as never,
      authContext: null as never,
      params: {},
    });

    const body = (await res.json()) as {
      providers: Array<Record<string, unknown>>;
    };

    const expectedKeys = [
      "provider_key",
      "display_name",
      "description",
      "dashboard_url",
      "client_id_placeholder",
      "requires_client_secret",
      "supports_managed_mode",
      "feature_flag",
    ];

    for (const provider of body.providers) {
      expect(Object.keys(provider).sort()).toEqual(expectedKeys.sort());
    }
  });

  test("supports_managed_mode=true returns only managed providers", async () => {
    const req = new Request(
      "http://localhost/v1/oauth/providers?supports_managed_mode=true",
    );
    const url = new URL(req.url);
    const res = await getRoute("GET", "oauth/providers").handler({
      req,
      url,
      server: null as never,
      authContext: null as never,
      params: {},
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{
        provider_key: string;
        supports_managed_mode: boolean;
      }>;
    };

    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]!.provider_key).toBe("google");
    expect(body.providers[0]!.supports_managed_mode).toBe(true);
  });

  test("supports_managed_mode=false returns only non-managed providers", async () => {
    const req = new Request(
      "http://localhost/v1/oauth/providers?supports_managed_mode=false",
    );
    const url = new URL(req.url);
    const res = await getRoute("GET", "oauth/providers").handler({
      req,
      url,
      server: null as never,
      authContext: null as never,
      params: {},
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{
        provider_key: string;
        supports_managed_mode: boolean;
      }>;
    };

    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]!.provider_key).toBe("github");
    expect(body.providers[0]!.supports_managed_mode).toBe(false);
  });
});

describe("GET /v1/oauth/providers/:providerKey", () => {
  test("returns the correct provider", async () => {
    const req = new Request("http://localhost/v1/oauth/providers/google");
    const url = new URL(req.url);
    const res = await getRoute("GET", "oauth/providers/:providerKey").handler({
      req,
      url,
      server: null as never,
      authContext: null as never,
      params: { providerKey: "google" },
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
      };
    };

    expect(body.provider.provider_key).toBe("google");
    expect(body.provider.display_name).toBe("Google");
    expect(body.provider.supports_managed_mode).toBe(true);
    expect(body.provider.requires_client_secret).toBe(true);
  });

  test("returns 404 for unknown provider", async () => {
    const req = new Request("http://localhost/v1/oauth/providers/nonexistent");
    const url = new URL(req.url);
    const res = await getRoute("GET", "oauth/providers/:providerKey").handler({
      req,
      url,
      server: null as never,
      authContext: null as never,
      params: { providerKey: "nonexistent" },
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
