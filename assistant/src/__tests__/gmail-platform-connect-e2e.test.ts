import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

let mockProvider: Record<string, unknown> | undefined;
let mockConnection: Record<string, unknown> | undefined;
let mockConfig: Record<string, unknown> = {};
let mockPlatformClient: Record<string, unknown> | null = null;
let mockAccessToken: string | undefined;

// ---------------------------------------------------------------------------
// Module mocks (must precede imports of the module under test)
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../oauth/oauth-store.js", () => ({
  getProvider: () => mockProvider,
  getActiveConnection: (
    _pk: string,
    opts?: { clientId?: string; account?: string },
  ) => {
    if (opts?.clientId && mockConnection?.clientId !== opts.clientId)
      return undefined;
    if (opts?.account && mockConnection?.accountInfo !== opts.account)
      return undefined;
    return mockConnection;
  },
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => mockAccessToken,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
}));

mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => mockPlatformClient,
  },
}));

// ---------------------------------------------------------------------------
// Import modules under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import {
  getMessage,
  getProfile,
  listMessages,
} from "../messaging/providers/gmail/client.js";
import { resolveOAuthConnection } from "../oauth/connection-resolver.js";
import {
  CredentialRequiredError,
  PlatformOAuthConnection,
  ProviderUnreachableError,
} from "../oauth/platform-connection.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Captured proxy requests for assertion. */
interface CapturedProxyRequest {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}

function makeMockPlatformClient(options?: {
  /** Map of connection-list response for provider lookups. */
  connectionListResponse?: { id: string; account_label?: string }[];
  /** Ordered list of proxy responses to return for sequential requests. */
  proxyResponses?: Array<{
    status: number;
    headers: Record<string, string>;
    body: unknown;
  }>;
}) {
  const connectionList = options?.connectionListResponse ?? [
    { id: "conn-google-managed-1", account_label: "user@gmail.com" },
  ];
  const proxyResponses = options?.proxyResponses ?? [];
  let proxyCallIndex = 0;
  const capturedRequests: CapturedProxyRequest[] = [];

  return {
    baseUrl: "https://platform.example.com",
    assistantApiKey: "sk-test-key",
    platformAssistantId: "asst-gmail-e2e",
    capturedRequests,
    fetch: mock(async (path: string, init?: RequestInit) => {
      // Connection list endpoint
      if (path.includes("/oauth/connections/")) {
        return new Response(JSON.stringify({ results: connectionList }), {
          status: 200,
        });
      }

      // Proxy endpoint — capture and return mock response
      if (path.includes("/external-provider-proxy/")) {
        const parsed = init?.body ? JSON.parse(init.body as string) : null;
        capturedRequests.push({
          path,
          method: init?.method ?? "GET",
          body: parsed,
        });

        const proxyResp = proxyResponses[proxyCallIndex++] ?? {
          status: 200,
          headers: { "content-type": "application/json" },
          body: null,
        };

        return new Response(JSON.stringify(proxyResp), { status: 200 });
      }

      // Catalog endpoint
      if (path.includes("/oauth/managed/catalog/")) {
        return new Response(
          JSON.stringify(
            connectionList.map((c) => ({
              handle: `platform_oauth:${c.id}`,
              connection_id: c.id,
              provider: "google",
              account_label: c.account_label ?? null,
              scopes_granted: ["https://mail.google.com/"],
              status: "active",
            })),
          ),
          { status: 200 },
        );
      }

      return new Response("Not Found", { status: 404 });
    }),
  };
}

function setupManagedGmailDefaults(): void {
  mockProvider = {
    providerKey: "google",
    baseUrl: "https://gmail.googleapis.com/gmail/v1/users/me",
    managedServiceConfigKey: "google-oauth",
  };
  mockConnection = undefined;
  mockAccessToken = undefined;
  mockConfig = {
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "google-oauth": { mode: "managed" },
    },
  };
  mockPlatformClient = makeMockPlatformClient();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Gmail platform connect E2E", () => {
  beforeEach(() => {
    setupManagedGmailDefaults();
  });

  // -------------------------------------------------------------------------
  // Connection resolution
  // -------------------------------------------------------------------------

  describe("managed connection resolution", () => {
    test("resolves google to PlatformOAuthConnection in managed mode", async () => {
      /** Resolving google in managed mode returns a platform connection. */

      // GIVEN google-oauth is configured in managed mode with a platform client
      // (set up by setupManagedGmailDefaults)

      // WHEN resolving the OAuth connection for google
      const connection = await resolveOAuthConnection("google");

      // THEN the connection is a PlatformOAuthConnection
      expect(connection).toBeInstanceOf(PlatformOAuthConnection);
      expect(connection.providerKey).toBe("google");
    });

    test("passes account identifier through to platform connection lookup", async () => {
      /** Account identifier disambiguates multi-account platform connections. */

      // GIVEN a platform client with a google connection
      // (set up by setupManagedGmailDefaults)

      // WHEN resolving with an explicit account
      const connection = await resolveOAuthConnection("google", {
        account: "user@gmail.com",
      });

      // THEN the connection carries the account info
      expect(connection).toBeInstanceOf(PlatformOAuthConnection);
      expect(connection.accountInfo).toBe("user@gmail.com");
    });

    test("throws when platform prerequisites are missing for managed google", async () => {
      /** Missing platform client blocks managed mode connection. */

      // GIVEN no platform client is available
      mockPlatformClient = null;

      // WHEN resolving google in managed mode
      // THEN an error is thrown about missing platform prerequisites
      await expect(resolveOAuthConnection("google")).rejects.toThrow(
        /missing platform prerequisites/,
      );
    });

    test("throws when platform returns no active connections", async () => {
      /** No active connections on the platform is an actionable error. */

      // GIVEN the platform returns an empty connection list
      mockPlatformClient = makeMockPlatformClient({
        connectionListResponse: [],
      });

      // WHEN resolving google in managed mode
      // THEN an error about no active connection is thrown
      await expect(resolveOAuthConnection("google")).rejects.toThrow(
        /No active platform OAuth connection/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Proxied Gmail API requests
  // -------------------------------------------------------------------------

  describe("proxied Gmail API requests", () => {
    test("listMessages proxies through platform and returns message list", async () => {
      /** Full flow: resolve managed connection, list messages via platform proxy. */

      // GIVEN a managed google connection with a mock platform proxy
      const client = makeMockPlatformClient({
        proxyResponses: [
          {
            status: 200,
            headers: { "content-type": "application/json" },
            body: {
              messages: [
                { id: "msg-1", threadId: "thread-1" },
                { id: "msg-2", threadId: "thread-2" },
              ],
              resultSizeEstimate: 2,
            },
          },
        ],
      });
      mockPlatformClient = client;

      // WHEN resolving the connection and listing messages
      const connection = await resolveOAuthConnection("google");
      const result = await listMessages(connection, "is:unread", 10);

      // THEN the proxy was called with the correct Gmail API path
      expect(client.capturedRequests).toHaveLength(1);
      const proxyReq = client.capturedRequests[0];
      expect(proxyReq.body?.request).toBeDefined();
      const innerReq = proxyReq.body!.request as Record<string, unknown>;
      expect(innerReq.method).toBe("GET");
      expect(innerReq.path).toBe("/messages");
      expect(innerReq.query).toEqual({
        q: "is:unread",
        maxResults: "10",
      });

      // AND the response contains the expected messages
      expect(result.messages).toHaveLength(2);
      expect(result.messages![0].id).toBe("msg-1");
      expect(result.messages![1].id).toBe("msg-2");
    });

    test("getMessage proxies single message fetch through platform", async () => {
      /** Fetching a single message routes through the platform proxy. */

      // GIVEN a managed connection with a mock message response
      const client = makeMockPlatformClient({
        proxyResponses: [
          {
            status: 200,
            headers: { "content-type": "application/json" },
            body: {
              id: "msg-abc",
              threadId: "thread-xyz",
              snippet: "Hello from Gmail",
              payload: { headers: [] },
            },
          },
        ],
      });
      mockPlatformClient = client;

      // WHEN resolving the connection and getting a single message
      const connection = await resolveOAuthConnection("google");
      const msg = await getMessage(connection, "msg-abc", "full");

      // THEN the proxy request targets the correct message path
      expect(client.capturedRequests).toHaveLength(1);
      const innerReq = client.capturedRequests[0].body!.request as Record<
        string,
        unknown
      >;
      expect(innerReq.path).toBe("/messages/msg-abc");
      expect(innerReq.query).toEqual({ format: "full" });

      // AND the message is returned correctly
      expect(msg.id).toBe("msg-abc");
      expect(msg.snippet).toBe("Hello from Gmail");
    });

    test("getProfile proxies profile fetch through platform", async () => {
      /** Profile retrieval works through the platform proxy. */

      // GIVEN a managed connection with a mock profile response
      const client = makeMockPlatformClient({
        proxyResponses: [
          {
            status: 200,
            headers: { "content-type": "application/json" },
            body: {
              emailAddress: "user@gmail.com",
              messagesTotal: 15000,
              threadsTotal: 8000,
              historyId: "12345",
            },
          },
        ],
      });
      mockPlatformClient = client;

      // WHEN resolving the connection and fetching the profile
      const connection = await resolveOAuthConnection("google");
      const profile = await getProfile(connection);

      // THEN the profile is returned with the correct email
      expect(profile.emailAddress).toBe("user@gmail.com");
      expect(profile.messagesTotal).toBe(15000);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling through the proxy
  // -------------------------------------------------------------------------

  describe("platform proxy error handling", () => {
    test("424 from platform proxy throws CredentialRequiredError", async () => {
      /** Platform returns 424 when the OAuth credential is missing or expired. */

      // GIVEN a platform client whose proxy returns 424
      const client = makeMockPlatformClient();
      (client.fetch as ReturnType<typeof mock>).mockImplementation(
        async (path: string) => {
          if (path.includes("/oauth/connections/")) {
            return new Response(
              JSON.stringify({
                results: [
                  { id: "conn-google-1", account_label: "user@gmail.com" },
                ],
              }),
              { status: 200 },
            );
          }
          return new Response("", { status: 424 });
        },
      );
      mockPlatformClient = client;

      // WHEN resolving and making a request
      const connection = await resolveOAuthConnection("google");

      // THEN the request throws CredentialRequiredError
      await expect(
        connection.request({ method: "GET", path: "/messages" }),
      ).rejects.toThrow(CredentialRequiredError);
    });

    test("502 from platform proxy throws ProviderUnreachableError", async () => {
      /** Platform returns 502 when the upstream provider (Gmail) is unreachable. */

      // GIVEN a platform client whose proxy returns 502
      const client = makeMockPlatformClient();
      (client.fetch as ReturnType<typeof mock>).mockImplementation(
        async (path: string) => {
          if (path.includes("/oauth/connections/")) {
            return new Response(
              JSON.stringify({
                results: [
                  { id: "conn-google-1", account_label: "user@gmail.com" },
                ],
              }),
              { status: 200 },
            );
          }
          return new Response("", { status: 502 });
        },
      );
      mockPlatformClient = client;

      // WHEN resolving and making a request
      const connection = await resolveOAuthConnection("google");

      // THEN the request throws ProviderUnreachableError
      await expect(
        connection.request({ method: "GET", path: "/messages" }),
      ).rejects.toThrow(ProviderUnreachableError);
    });

    test("withToken throws for platform-managed connections (batch fallback)", async () => {
      /** Platform connections cannot expose raw tokens; batch API falls back to individual fetches. */

      // GIVEN a managed google connection
      const connection = await resolveOAuthConnection("google");

      // WHEN withToken is called (e.g. by Gmail batch API)
      // THEN it throws, triggering the individual fetch fallback
      await expect(
        connection.withToken(async (token) => token),
      ).rejects.toThrow(
        "Raw token access is not supported for platform-managed connections",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Mode switching
  // -------------------------------------------------------------------------

  describe("mode switching between managed and BYO", () => {
    test("BYO mode bypasses platform and uses local credentials", async () => {
      /** When google-oauth mode is your-own, local credentials are used instead of platform. */

      // GIVEN google-oauth is configured in your-own mode
      mockConfig = {
        services: {
          inference: {
            mode: "your-own",
            provider: "anthropic",
            model: "claude-opus-4-6",
          },
          "google-oauth": { mode: "your-own" },
        },
      };

      // AND a local BYO connection exists
      mockConnection = {
        id: "byo-conn-1",
        providerKey: "google",
        oauthAppId: "app-1",
        accountInfo: "user@gmail.com",
        grantedScopes: JSON.stringify(["https://mail.google.com/"]),
        status: "active",
        clientId: "byo-client-id",
      };
      mockAccessToken = "byo-access-token";

      // WHEN resolving the OAuth connection for google
      const connection = await resolveOAuthConnection("google");

      // THEN the connection is NOT a PlatformOAuthConnection
      expect(connection).not.toBeInstanceOf(PlatformOAuthConnection);
      expect(connection.id).toBe("byo-conn-1");
      expect(connection.providerKey).toBe("google");
    });

    test("managed mode does not require local connection row or access token", async () => {
      /** Managed mode works with platform only — no local state needed. */

      // GIVEN no local connection or access token exists
      mockConnection = undefined;
      mockAccessToken = undefined;

      // AND google-oauth is in managed mode (set up by setupManagedGmailDefaults)

      // WHEN resolving the OAuth connection
      const connection = await resolveOAuthConnection("google");

      // THEN the connection resolves successfully via the platform
      expect(connection).toBeInstanceOf(PlatformOAuthConnection);
    });
  });
});
