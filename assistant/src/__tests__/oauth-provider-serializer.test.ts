import { describe, expect, test } from "bun:test";

import type { OAuthProviderRow } from "../oauth/oauth-store.js";
import {
  serializeProvider,
  serializeProviderSummary,
} from "../oauth/provider-serializer.js";

/** Helper to build a minimal valid provider row with sensible defaults. */
function makeRow(overrides: Partial<OAuthProviderRow> = {}): OAuthProviderRow {
  const now = Date.now();
  return {
    provider: "test-provider",
    authorizeUrl: "https://auth.example.com/authorize",
    tokenExchangeUrl: "https://auth.example.com/token",
    refreshUrl: null,
    tokenEndpointAuthMethod: "client_secret_post",
    tokenExchangeBodyFormat: "form",
    userinfoUrl: null,
    baseUrl: null,
    defaultScopes: "[]",
    scopePolicy: "{}",
    scopeSeparator: " ",
    authorizeParams: null,
    pingUrl: null,
    pingMethod: null,
    pingHeaders: null,
    pingBody: null,
    revokeUrl: null,
    revokeBodyTemplate: null,
    managedServiceConfigKey: null,
    displayLabel: null,
    description: null,
    dashboardUrl: null,
    clientIdPlaceholder: null,
    logoUrl: null,
    requiresClientSecret: 1,
    loopbackPort: null,
    injectionTemplates: null,
    appType: null,
    setupNotes: null,
    identityUrl: null,
    identityMethod: null,
    identityHeaders: null,
    identityBody: null,
    identityResponsePaths: null,
    identityFormat: null,
    identityOkField: null,
    featureFlag: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("serializeProvider", () => {
  test("parses JSON fields correctly", () => {
    const row = makeRow({
      defaultScopes: JSON.stringify(["openid", "email"]),
      scopePolicy: JSON.stringify({ required: ["openid"] }),
      authorizeParams: JSON.stringify({ access_type: "offline" }),
      pingHeaders: JSON.stringify({ "X-Api-Version": "2" }),
      pingBody: JSON.stringify({ query: "{ me { id } }" }),
      injectionTemplates: JSON.stringify([
        {
          hostPattern: "api.example.com",
          injectionType: "header",
          headerName: "Authorization",
          valuePrefix: "Bearer ",
        },
      ]),
      setupNotes: JSON.stringify(["Enable the API", "Add test users"]),
      identityHeaders: JSON.stringify({ "Notion-Version": "2022-06-28" }),
      identityBody: JSON.stringify({ query: "{ viewer { email } }" }),
      identityResponsePaths: JSON.stringify(["email", "name"]),
    });

    const result = serializeProvider(row)!;

    expect(result.defaultScopes).toEqual(["openid", "email"]);
    expect(result.scopePolicy).toEqual({ required: ["openid"] });
    expect(result.extraParams).toEqual({ access_type: "offline" });
    expect(result.pingHeaders).toEqual({ "X-Api-Version": "2" });
    expect(result.pingBody).toEqual({ query: "{ me { id } }" });
    expect(result.injectionTemplates).toEqual([
      {
        hostPattern: "api.example.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ]);
    expect(result.setupNotes).toEqual(["Enable the API", "Add test users"]);
    expect(result.identityHeaders).toEqual({ "Notion-Version": "2022-06-28" });
    expect(result.identityBody).toEqual({ query: "{ viewer { email } }" });
    expect(result.identityResponsePaths).toEqual(["email", "name"]);
  });

  test("returns empty defaults for null/missing JSON fields", () => {
    const row = makeRow();
    const result = serializeProvider(row)!;

    expect(result.defaultScopes).toEqual([]);
    expect(result.scopePolicy).toEqual({});
    expect(result.extraParams).toBeNull();
    expect(result.pingHeaders).toBeNull();
    expect(result.pingBody).toBeNull();
    expect(result.injectionTemplates).toBeNull();
    expect(result.setupNotes).toBeNull();
    expect(result.identityHeaders).toBeNull();
    expect(result.identityBody).toBeNull();
    expect(result.identityResponsePaths).toBeNull();
  });

  test("supportsManagedMode is true when managedServiceConfigKey is non-null", () => {
    const row = makeRow({ managedServiceConfigKey: "google-managed" });
    const result = serializeProvider(row)!;
    expect(result.supportsManagedMode).toBe(true);
  });

  test("supportsManagedMode is false when managedServiceConfigKey is null", () => {
    const row = makeRow({ managedServiceConfigKey: null });
    const result = serializeProvider(row)!;
    expect(result.supportsManagedMode).toBe(false);
  });

  test("requiresClientSecret defaults to true when value is 1", () => {
    const row = makeRow({ requiresClientSecret: 1 });
    const result = serializeProvider(row)!;
    expect(result.requiresClientSecret).toBe(true);
  });

  test("requiresClientSecret is false when value is 0", () => {
    const row = makeRow({ requiresClientSecret: 0 });
    const result = serializeProvider(row)!;
    expect(result.requiresClientSecret).toBe(false);
  });

  test("requiresClientSecret defaults to true when coerced from default integer 1", () => {
    // The DB column defaults to 1 — verify the serializer treats it as true.
    const row = makeRow();
    const result = serializeProvider(row)!;
    expect(result.requiresClientSecret).toBe(true);
  });

  test("timestamps are converted to ISO strings", () => {
    const ts = 1700000000000;
    const row = makeRow({ createdAt: ts, updatedAt: ts });
    const result = serializeProvider(row)!;

    expect(result.createdAt).toBe(new Date(ts).toISOString());
    expect(result.updatedAt).toBe(new Date(ts).toISOString());
  });

  test("accepts a redirectUri override via options", () => {
    const row = makeRow();
    const result = serializeProvider(row, {
      redirectUri: "http://localhost:8080/oauth/callback",
    })!;
    expect(result.redirectUri).toBe("http://localhost:8080/oauth/callback");
  });

  test("redirectUri defaults to null when no override is provided", () => {
    const row = makeRow();
    const result = serializeProvider(row)!;
    expect(result.redirectUri).toBeNull();
  });

  test("returns undefined for undefined input", () => {
    expect(serializeProvider(undefined)).toBeUndefined();
  });

  test("returns null for null input", () => {
    expect(serializeProvider(null)).toBeNull();
  });

  test("emits scopeSeparator from the row when set to ','", () => {
    const row = makeRow({ scopeSeparator: "," });
    const result = serializeProvider(row)!;
    expect(result.scopeSeparator).toBe(",");
  });

  test("emits scopeSeparator default ' ' when row uses the default", () => {
    const row = makeRow({ scopeSeparator: " " });
    const result = serializeProvider(row)!;
    expect(result.scopeSeparator).toBe(" ");
  });

  test("emits refreshUrl from the row when set to a URL", () => {
    const row = makeRow({
      refreshUrl: "https://refresh.example.com/token",
    });
    const result = serializeProvider(row)!;
    expect(result.refreshUrl).toBe("https://refresh.example.com/token");
  });

  test("emits refreshUrl as null when the row value is null", () => {
    const row = makeRow({ refreshUrl: null });
    const result = serializeProvider(row)!;
    expect(result.refreshUrl).toBeNull();
  });

  test("emits revokeUrl from the row and parses revokeBodyTemplate JSON", () => {
    const row = makeRow({
      revokeUrl: "https://revoke.example.com",
      revokeBodyTemplate: JSON.stringify({ token: "{access_token}" }),
    });
    const result = serializeProvider(row)!;
    expect(result.revokeUrl).toBe("https://revoke.example.com");
    expect(result.revokeBodyTemplate).toEqual({ token: "{access_token}" });
    // Make sure it's a parsed object, not a string.
    expect(typeof result.revokeBodyTemplate).toBe("object");
    expect(result.revokeBodyTemplate).not.toBe(
      JSON.stringify({ token: "{access_token}" }),
    );
  });

  test("emits revokeUrl and revokeBodyTemplate as null when the row values are null", () => {
    const row = makeRow({
      revokeUrl: null,
      revokeBodyTemplate: null,
    });
    const result = serializeProvider(row)!;
    expect(result.revokeUrl).toBeNull();
    expect(result.revokeBodyTemplate).toBeNull();
  });

  test("normalizes empty string revokeUrl to null on the serialized output", () => {
    // Legacy rows or rows that reached the store via an empty-string update
    // may persist `revokeUrl: ""`. The serializer should normalize this to
    // null so wire consumers (CLI --json, HTTP API) see a consistent
    // "disabled" signal.
    const row = makeRow({ revokeUrl: "" });
    const result = serializeProvider(row)!;
    expect(result.revokeUrl).toBeNull();
  });

  test("preserves all keys in a complex revokeBodyTemplate", () => {
    const template = {
      token: "{access_token}",
      client_id: "{client_id}",
      token_type_hint: "access_token",
      extra_field: "static-value",
    };
    const row = makeRow({
      revokeUrl: "https://revoke.example.com/oauth/revoke",
      revokeBodyTemplate: JSON.stringify(template),
    });
    const result = serializeProvider(row)!;
    expect(result.revokeBodyTemplate).toEqual(template);
  });

  test("serializeProvider exposes logoUrl", () => {
    const row = makeRow({
      logoUrl: "https://cdn.simpleicons.org/notion",
    });
    const result = serializeProvider(row)!;
    expect(result.logoUrl).toBe("https://cdn.simpleicons.org/notion");
  });

  test("serializeProvider emits logoUrl as null when row value is null", () => {
    const row = makeRow({ logoUrl: null });
    const result = serializeProvider(row)!;
    expect(result.logoUrl).toBeNull();
  });
});

describe("serializeProviderSummary", () => {
  test("returns the expected subset of fields in snake_case", () => {
    const row = makeRow({
      provider: "google",
      displayLabel: "Google",
      description: "Google OAuth 2.0",
      dashboardUrl: "https://console.cloud.google.com",
      clientIdPlaceholder: "your-client-id.apps.googleusercontent.com",
      requiresClientSecret: 1,
      managedServiceConfigKey: "google-managed",
    });

    const result = serializeProviderSummary(row)!;

    expect(result).toEqual({
      provider_key: "google",
      display_name: "Google",
      description: "Google OAuth 2.0",
      dashboard_url: "https://console.cloud.google.com",
      client_id_placeholder: "your-client-id.apps.googleusercontent.com",
      requires_client_secret: true,
      logo_url: null,
      supports_managed_mode: true,
      feature_flag: null,
    });
  });

  test("nullifies missing optional fields", () => {
    const row = makeRow({
      displayLabel: null,
      description: null,
      dashboardUrl: null,
      clientIdPlaceholder: null,
    });

    const result = serializeProviderSummary(row)!;

    expect(result.display_name).toBeNull();
    expect(result.description).toBeNull();
    expect(result.dashboard_url).toBeNull();
    expect(result.client_id_placeholder).toBeNull();
  });

  test("requires_client_secret is false when value is 0", () => {
    const row = makeRow({ requiresClientSecret: 0 });
    const result = serializeProviderSummary(row)!;
    expect(result.requires_client_secret).toBe(false);
  });

  test("supports_managed_mode is false when managedServiceConfigKey is null", () => {
    const row = makeRow({ managedServiceConfigKey: null });
    const result = serializeProviderSummary(row)!;
    expect(result.supports_managed_mode).toBe(false);
  });

  test("returns null for null input", () => {
    expect(serializeProviderSummary(null)).toBeNull();
  });

  test("returns null for undefined input", () => {
    expect(serializeProviderSummary(undefined)).toBeNull();
  });

  test("does NOT include scope_separator (intentionally omitted from the HTTP summary)", () => {
    const row = makeRow({ scopeSeparator: "," });
    const result = serializeProviderSummary(row)!;
    expect(result).not.toHaveProperty("scope_separator");
    expect(result).not.toHaveProperty("scopeSeparator");
  });

  test("does NOT include refresh_url (intentionally omitted from the HTTP summary)", () => {
    const row = makeRow({ refreshUrl: "https://refresh.example.com/token" });
    const result = serializeProviderSummary(row)!;
    expect(result).not.toHaveProperty("refresh_url");
    expect(result).not.toHaveProperty("refreshUrl");
  });

  test("does NOT include revoke_url or revoke_body_template (internal protocol details)", () => {
    const row = makeRow({
      revokeUrl: "https://revoke.example.com",
      revokeBodyTemplate: JSON.stringify({ token: "{access_token}" }),
    });
    const result = serializeProviderSummary(row)!;
    expect(result).not.toHaveProperty("revoke_url");
    expect(result).not.toHaveProperty("revokeUrl");
    expect(result).not.toHaveProperty("revoke_body_template");
    expect(result).not.toHaveProperty("revokeBodyTemplate");
  });

  test("serializeProviderSummary exposes logo_url", () => {
    const row = makeRow({
      logoUrl: "https://cdn.simpleicons.org/notion",
    });
    const result = serializeProviderSummary(row)!;
    expect(result).toHaveProperty("logo_url");
    expect(result.logo_url).toBe("https://cdn.simpleicons.org/notion");
  });

  test("logo_url is null when row logoUrl is null", () => {
    const result = serializeProviderSummary({ ...makeRow(), logoUrl: null })!;
    expect(result.logo_url).toBeNull();
  });
});
