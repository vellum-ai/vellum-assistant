import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { verifyIdentity } from "../identity-verifier.js";
import type { OAuthProviderRow } from "../oauth-store.js";

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock<any>>;

beforeEach(() => {
  mockFetch = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Helper: build a minimal OAuthProviderRow with identity fields
// ---------------------------------------------------------------------------

function makeProviderRow(
  overrides: Partial<OAuthProviderRow> & { provider: string },
): OAuthProviderRow {
  const now = Date.now();
  const { provider, ...rest } = overrides;
  return {
    provider,
    authorizeUrl: "https://example.com/auth",
    tokenExchangeUrl: "https://example.com/token",
    tokenEndpointAuthMethod: null,
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
    managedServiceConfigKey: null,
    displayLabel: null,
    description: null,
    dashboardUrl: null,
    clientIdPlaceholder: null,
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
    ...rest,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verifyIdentity", () => {
  // -----------------------------------------------------------------------
  // Missing identity URL
  // -----------------------------------------------------------------------
  test("returns undefined when identityUrl is null", async () => {
    const row = makeProviderRow({ provider: "custom" });
    const result = await verifyIdentity(row, "token-abc");
    expect(result).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Google: simple GET, extract email
  // -----------------------------------------------------------------------
  describe("Google pattern", () => {
    const googleRow = makeProviderRow({
      provider: "google",
      identityUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
      identityResponsePaths: JSON.stringify(["email"]),
    });

    test("extracts email from response", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ email: "user@gmail.com", name: "Test User" }),
      );

      const result = await verifyIdentity(googleRow, "google-token");

      expect(result).toBe("user@gmail.com");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://www.googleapis.com/oauth2/v2/userinfo");
      expect((init as RequestInit).method).toBe("GET");
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer google-token");
    });

    test("returns undefined when email is missing", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ name: "Test User" }));
      const result = await verifyIdentity(googleRow, "google-token");
      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Slack: GET with ok check + format template
  // -----------------------------------------------------------------------
  describe("Slack pattern", () => {
    const slackRow = makeProviderRow({
      provider: "slack",
      identityUrl: "https://slack.com/api/auth.test",
      identityOkField: "ok",
      identityResponsePaths: JSON.stringify(["user", "team"]),
      identityFormat: "@${user} (${team})",
    });

    test("returns formatted string when all fields present", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, user: "alice", team: "acme-corp" }),
      );

      const result = await verifyIdentity(slackRow, "slack-token");
      expect(result).toBe("@alice (acme-corp)");
    });

    test("returns @user when team is missing (fallback)", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, user: "alice" }),
      );

      const result = await verifyIdentity(slackRow, "slack-token");
      expect(result).toBe("@alice");
    });

    test("returns undefined when ok is false", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: false, user: "alice", team: "acme-corp" }),
      );

      const result = await verifyIdentity(slackRow, "slack-token");
      expect(result).toBeUndefined();
    });

    test("returns undefined when ok field is missing", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ user: "alice", team: "acme-corp" }),
      );

      const result = await verifyIdentity(slackRow, "slack-token");
      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // HubSpot: URL-interpolated token, no Authorization header
  // -----------------------------------------------------------------------
  describe("HubSpot pattern", () => {
    const hubspotRow = makeProviderRow({
      provider: "hubspot",
      identityUrl:
        "https://api.hubapi.com/oauth/v1/access-tokens/${accessToken}",
      identityResponsePaths: JSON.stringify(["user", "hub_domain"]),
    });

    test("interpolates token in URL and skips Authorization header", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          user: "admin@hubspot.com",
          hub_domain: "mycompany.hubspot.com",
        }),
      );

      const result = await verifyIdentity(hubspotRow, "hs-token-123");

      expect(result).toBe("admin@hubspot.com");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "https://api.hubapi.com/oauth/v1/access-tokens/hs-token-123",
      );
      const headers = (init as RequestInit).headers as Record<string, string>;
      // Should NOT have Authorization header since token is in URL
      expect(headers["Authorization"]).toBeUndefined();
    });

    test("falls back to hub_domain when user is missing", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ hub_domain: "mycompany.hubspot.com" }),
      );

      const result = await verifyIdentity(hubspotRow, "hs-token-123");
      expect(result).toBe("mycompany.hubspot.com");
    });
  });

  // -----------------------------------------------------------------------
  // Linear: POST with JSON body, GraphQL response
  // -----------------------------------------------------------------------
  describe("Linear pattern", () => {
    const linearRow = makeProviderRow({
      provider: "linear",
      identityUrl: "https://api.linear.app/graphql",
      identityMethod: "POST",
      identityHeaders: JSON.stringify({ "Content-Type": "application/json" }),
      identityBody: JSON.stringify({
        query: "{ viewer { email name } }",
      }),
      identityResponsePaths: JSON.stringify([
        "data.viewer.email",
        "data.viewer.name",
      ]),
    });

    test("extracts email from nested GraphQL response", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: { viewer: { email: "dev@linear.app", name: "Dev User" } },
        }),
      );

      const result = await verifyIdentity(linearRow, "linear-token");

      expect(result).toBe("dev@linear.app");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.linear.app/graphql");
      expect((init as RequestInit).method).toBe("POST");
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer linear-token");
      expect(headers["Content-Type"]).toBe("application/json");
      expect((init as RequestInit).body).toBe(
        JSON.stringify({ query: "{ viewer { email name } }" }),
      );
    });

    test("falls back to name when email is missing", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: { viewer: { name: "Dev User" } },
        }),
      );

      const result = await verifyIdentity(linearRow, "linear-token");
      expect(result).toBe("Dev User");
    });
  });

  // -----------------------------------------------------------------------
  // Todoist: POST with form body
  // -----------------------------------------------------------------------
  describe("Todoist pattern", () => {
    const todoistRow = makeProviderRow({
      provider: "todoist",
      identityUrl: "https://api.todoist.com/sync/v9/sync",
      identityMethod: "POST",
      identityHeaders: JSON.stringify({
        "Content-Type": "application/x-www-form-urlencoded",
      }),
      identityBody: JSON.stringify("sync_token=*&resource_types=[%22user%22]"),
      identityResponsePaths: JSON.stringify(["user.full_name", "user.email"]),
    });

    test("extracts full_name from nested response", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          user: { full_name: "Jane Doe", email: "jane@example.com" },
        }),
      );

      const result = await verifyIdentity(todoistRow, "todoist-token");

      expect(result).toBe("Jane Doe");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [, init] = mockFetch.mock.calls[0];
      expect((init as RequestInit).method).toBe("POST");
      // Body should be the form-encoded string
      expect((init as RequestInit).body).toBe(
        "sync_token=*&resource_types=[%22user%22]",
      );
    });

    test("falls back to email when full_name is missing", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ user: { email: "jane@example.com" } }),
      );

      const result = await verifyIdentity(todoistRow, "todoist-token");
      expect(result).toBe("jane@example.com");
    });
  });

  // -----------------------------------------------------------------------
  // Twitter: format template with nested path
  // -----------------------------------------------------------------------
  describe("Twitter pattern", () => {
    const twitterRow = makeProviderRow({
      provider: "twitter",
      identityUrl: "https://api.x.com/2/users/me",
      identityResponsePaths: JSON.stringify(["data.username"]),
      identityFormat: "@${data.username}",
    });

    test("returns formatted @username", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { username: "elonmusk" } }),
      );

      const result = await verifyIdentity(twitterRow, "twitter-token");
      expect(result).toBe("@elonmusk");
    });
  });

  // -----------------------------------------------------------------------
  // GitHub: format template with simple path
  // -----------------------------------------------------------------------
  describe("GitHub pattern", () => {
    const githubRow = makeProviderRow({
      provider: "github",
      identityUrl: "https://api.github.com/user",
      identityResponsePaths: JSON.stringify(["login"]),
      identityFormat: "@${login}",
    });

    test("returns formatted @login", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ login: "octocat" }));

      const result = await verifyIdentity(githubRow, "gh-token");
      expect(result).toBe("@octocat");
    });
  });

  // -----------------------------------------------------------------------
  // Notion: custom headers, multiple fallback paths
  // -----------------------------------------------------------------------
  describe("Notion pattern", () => {
    const notionRow = makeProviderRow({
      provider: "notion",
      identityUrl: "https://api.notion.com/v1/users/me",
      identityHeaders: JSON.stringify({ "Notion-Version": "2022-06-28" }),
      identityResponsePaths: JSON.stringify(["name", "person.email"]),
    });

    test("returns name when present", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ name: "Test Bot", person: { email: "user@notion.so" } }),
      );

      const result = await verifyIdentity(notionRow, "notion-token");
      expect(result).toBe("Test Bot");

      const [, init] = mockFetch.mock.calls[0];
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers["Notion-Version"]).toBe("2022-06-28");
      expect(headers["Authorization"]).toBe("Bearer notion-token");
    });

    test("falls back to person.email when name is missing", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ person: { email: "user@notion.so" } }),
      );

      const result = await verifyIdentity(notionRow, "notion-token");
      expect(result).toBe("user@notion.so");
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------
  describe("error handling", () => {
    const googleRow = makeProviderRow({
      provider: "google",
      identityUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
      identityResponsePaths: JSON.stringify(["email"]),
    });

    test("returns undefined on fetch failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await verifyIdentity(googleRow, "token");
      expect(result).toBeUndefined();
    });

    test("returns undefined on non-OK response", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401 }),
      );

      const result = await verifyIdentity(googleRow, "token");
      expect(result).toBeUndefined();
    });

    test("returns undefined on invalid JSON response", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response("not json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await verifyIdentity(googleRow, "token");
      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Dropbox: POST with no explicit body
  // -----------------------------------------------------------------------
  describe("Dropbox pattern", () => {
    const dropboxRow = makeProviderRow({
      provider: "dropbox",
      identityUrl: "https://api.dropboxapi.com/2/users/get_current_account",
      identityMethod: "POST",
      identityResponsePaths: JSON.stringify(["name.display_name", "email"]),
    });

    test("extracts nested display_name", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          name: { display_name: "Jane Doe" },
          email: "jane@dropbox.com",
        }),
      );

      const result = await verifyIdentity(dropboxRow, "dbx-token");
      expect(result).toBe("Jane Doe");

      const [, init] = mockFetch.mock.calls[0];
      expect((init as RequestInit).method).toBe("POST");
    });

    test("falls back to email when name is missing", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ email: "jane@dropbox.com" }),
      );

      const result = await verifyIdentity(dropboxRow, "dbx-token");
      expect(result).toBe("jane@dropbox.com");
    });
  });
});
