import { describe, expect, mock, test } from "bun:test";

const mockListProviders = mock(() => [
  {
    provider: "google",
    displayLabel: "Google",
    description: "Google OAuth provider",
    dashboardUrl: "https://console.cloud.google.com/apis/credentials",
    clientIdPlaceholder: null,
    logoUrl: "https://cdn.simpleicons.org/google",
    requiresClientSecret: 1,
    managedServiceConfigKey: "google-oauth",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenExchangeUrl: "https://oauth2.googleapis.com/token",
    refreshUrl: null,
    tokenEndpointAuthMethod: "client_secret_post",
    tokenExchangeBodyFormat: "form",
    userinfoUrl: null,
    baseUrl: null,
    defaultScopes: "[]",
    availableScopes: null,
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
    logoUrl: null,
    requiresClientSecret: 1,
    managedServiceConfigKey: null,
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenExchangeUrl: "https://github.com/login/oauth/access_token",
    refreshUrl: null,
    tokenEndpointAuthMethod: "client_secret_post",
    tokenExchangeBodyFormat: "form",
    userinfoUrl: null,
    baseUrl: null,
    defaultScopes: "[]",
    availableScopes: null,
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

import { NotFoundError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/oauth-providers.js";
import type { RouteDefinition, RouteHandlerArgs } from "../runtime/routes/types.js";

function getRoute(method: string, endpoint: string): RouteDefinition {
  const route = ROUTES.find(
    (r: RouteDefinition) => r.method === method && r.endpoint === endpoint,
  );
  if (!route) throw new Error(`Route not found: ${method} ${endpoint}`);
  return route;
}

/** Call a route handler, catching RouteErrors for test assertions. */
async function callRoute(
  route: RouteDefinition,
  args: RouteHandlerArgs,
): Promise<{ status: number; body: unknown }> {
  try {
    const result = await route.handler(args);
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof NotFoundError) {
      return { status: err.statusCode, body: { error: { code: err.code, message: err.message } } };
    }
    throw err;
  }
}

describe("GET /v1/oauth/providers", () => {
  test("returns all providers with correct summary shape", async () => {
    const { status, body } = await callRoute(
      getRoute("GET", "oauth/providers"),
      { queryParams: {} },
    );

    expect(status).toBe(200);
    const { providers } = body as {
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

    expect(providers).toHaveLength(2);
    expect(providers[0]!.provider_key).toBe("google");
    expect(providers[1]!.provider_key).toBe("github");
  });

  test("response shape matches serializeProviderSummary output (snake_case keys)", async () => {
    const { body } = await callRoute(
      getRoute("GET", "oauth/providers"),
      { queryParams: {} },
    );

    const { providers } = body as {
      providers: Array<Record<string, unknown>>;
    };

    const expectedKeys = [
      "provider_key",
      "display_name",
      "description",
      "dashboard_url",
      "client_id_placeholder",
      "requires_client_secret",
      "logo_url",
      "supports_managed_mode",
      "managed_service_is_paid",
      "feature_flag",
    ];

    for (const provider of providers) {
      expect(Object.keys(provider).sort()).toEqual(expectedKeys.sort());
    }
  });

  test("response includes logo_url for each provider", async () => {
    const { status, body } = await callRoute(
      getRoute("GET", "oauth/providers"),
      { queryParams: {} },
    );

    expect(status).toBe(200);
    const { providers } = body as {
      providers: Array<{
        provider_key: string;
        logo_url: string | null;
      }>;
    };

    expect(providers[0]!.logo_url).toBe(
      "https://cdn.simpleicons.org/google",
    );
    expect(providers[1]!.logo_url).toBeNull();
  });

  test("supports_managed_mode=true returns only managed providers", async () => {
    const { status, body } = await callRoute(
      getRoute("GET", "oauth/providers"),
      { queryParams: { supports_managed_mode: "true" } },
    );

    expect(status).toBe(200);
    const { providers } = body as {
      providers: Array<{
        provider_key: string;
        supports_managed_mode: boolean;
      }>;
    };

    expect(providers).toHaveLength(1);
    expect(providers[0]!.provider_key).toBe("google");
    expect(providers[0]!.supports_managed_mode).toBe(true);
  });

  test("supports_managed_mode=false returns only non-managed providers", async () => {
    const { status, body } = await callRoute(
      getRoute("GET", "oauth/providers"),
      { queryParams: { supports_managed_mode: "false" } },
    );

    expect(status).toBe(200);
    const { providers } = body as {
      providers: Array<{
        provider_key: string;
        supports_managed_mode: boolean;
      }>;
    };

    expect(providers).toHaveLength(1);
    expect(providers[0]!.provider_key).toBe("github");
    expect(providers[0]!.supports_managed_mode).toBe(false);
  });
});

describe("GET /v1/oauth/providers/:providerKey", () => {
  test("returns the correct provider", async () => {
    const { status, body } = await callRoute(
      getRoute("GET", "oauth/providers/:providerKey"),
      { pathParams: { providerKey: "google" } },
    );

    expect(status).toBe(200);
    const { provider } = body as {
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

    expect(provider.provider_key).toBe("google");
    expect(provider.display_name).toBe("Google");
    expect(provider.supports_managed_mode).toBe(true);
    expect(provider.requires_client_secret).toBe(true);
  });

  test("returns 404 for unknown provider", async () => {
    const { status, body } = await callRoute(
      getRoute("GET", "oauth/providers/:providerKey"),
      { pathParams: { providerKey: "nonexistent" } },
    );

    expect(status).toBe(404);
    const { error } = body as { error: { code: string } };
    expect(error.code).toBe("NOT_FOUND");
  });
});
