import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockGetProvider: (
  key: string,
) => Record<string, unknown> | undefined = () => undefined;

let mockGetAppByProviderAndClientId: (
  key: string,
  clientId: string,
) => Record<string, unknown> | undefined = () => undefined;

let mockGetMostRecentAppByProvider: (
  key: string,
) => Record<string, unknown> | undefined = () => undefined;

let mockOrchestrateOAuthConnect: (
  opts: Record<string, unknown>,
) => Promise<Record<string, unknown>> = async () => ({
  success: true,
  deferred: false,
  grantedScopes: [],
});

let mockGetSecureKeyAsync: (
  account: string,
) => Promise<string | undefined> = async () => undefined;

let mockOpenInBrowserCalls: string[] = [];
let mockPlatformClientResult: Record<string, unknown> | null = null;
let mockPlatformFetchResults: Array<{
  ok: boolean;
  status: number;
  body: unknown;
}> = [];
let mockPlatformFetchCallIndex = 0;
// Captures the path + parsed JSON body of each platform fetch call so tests can
// assert on what was actually sent to /v1/assistants/.../oauth/.../start/ etc.
let mockPlatformFetchCalls: Array<{ path: string; body: unknown }> = [];

let mockIsManagedMode: (key: string) => boolean = () => false;

// Configurable logger mock: by default no-ops; individual tests can override
// mockLogInfo to write to process.stdout so the JSON-mode suppression guard is
// exercised (the real CLI logger writes log lines to stdout).
let mockLogInfo: (msg: string) => void = () => {};

let mockCliIpcCallFn: (
  method: string,
  params?: Record<string, unknown>,
  opts?: { timeoutMs?: number },
) => Promise<{
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
}> = async () => ({
  ok: false,
  error: "IPC unavailable (default mock — forces fallback)",
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => ({ services: {} }),
  API_KEY_PROVIDERS: [],
}));

mock.module("../../../../oauth/oauth-store.js", () => ({
  getProvider: (key: string) => mockGetProvider(key),
  getAppByProviderAndClientId: (key: string, clientId: string) =>
    mockGetAppByProviderAndClientId(key, clientId),
  getMostRecentAppByProvider: (key: string) =>
    mockGetMostRecentAppByProvider(key),
  listConnections: () => [],
  getConnection: () => undefined,
  getConnectionByProvider: () => undefined,
  getActiveConnection: () => undefined,
  listActiveConnectionsByProvider: () => [],
  disconnectOAuthProvider: async () => "not-found" as const,
  upsertApp: async () => ({}),
  getApp: () => undefined,
  listApps: () => [],
  deleteApp: async () => false,
  listProviders: () => [],
  registerProvider: () => ({}),
  seedProviders: () => {},
  isProviderConnected: () => false,
  createConnection: () => ({}),
  updateConnection: () => ({}),
  deleteConnection: () => false,
}));

mock.module("../../../../oauth/connect-orchestrator.js", () => ({
  orchestrateOAuthConnect: (opts: Record<string, unknown>) =>
    mockOrchestrateOAuthConnect(opts),
}));

mock.module("../../../../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => mockPlatformClientResult,
  },
}));

mock.module("../../../../util/browser.js", () => ({
  openInHostBrowser: async (url: string) => {
    mockOpenInBrowserCalls.push(url);
  },
}));

mock.module("../../../../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: (msg: string) => mockLogInfo(msg),
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

mock.module("../../../../security/secure-keys.js", () => ({
  getSecureKeyAsync: (account: string) => mockGetSecureKeyAsync(account),
  getSecureKeyResultAsync: async () => ({
    value: undefined,
    unreachable: false,
  }),
  setSecureKeyAsync: async () => true,
  deleteSecureKeyAsync: async () => "deleted" as const,
  getProviderKeyAsync: async () => undefined,
  getMaskedProviderKey: async () => undefined,
  bulkSetSecureKeysAsync: async () => {},
  listSecureKeysAsync: async () => ({ credentials: [] }),
  setCesClient: () => {},
  onCesClientChanged: () => ({ unsubscribe: () => {} }),
  setCesReconnect: () => {},
  getActiveBackendName: () => "file",
  _resetBackend: () => {},
}));

mock.module("../../../../ipc/cli-client.js", () => ({
  cliIpcCall: (
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ) => mockCliIpcCallFn(method, params, opts),
}));

mock.module("../../../lib/daemon-credential-client.js", () => ({
  deleteSecureKeyViaDaemon: async () => "not-found" as const,
  setSecureKeyViaDaemon: async () => false,
}));

// Mock shared.js helpers to control managed vs BYO mode routing
mock.module("../shared.js", () => ({
  isManagedMode: (key: string) => mockIsManagedMode(key),
  requirePlatformClient: async (_cmd: Command) => {
    if (
      !mockPlatformClientResult ||
      !(mockPlatformClientResult as Record<string, unknown>).platformAssistantId
    ) {
      process.exitCode = 1;
      process.stdout.write(
        JSON.stringify({
          ok: false,
          error:
            "Not connected to Vellum platform. Run `vellum platform connect` to connect first.",
        }) + "\n",
      );
      return null;
    }
    return {
      platformAssistantId: (mockPlatformClientResult as Record<string, unknown>)
        .platformAssistantId,
      fetch: async (path: string, init?: RequestInit): Promise<Response> => {
        let parsedBody: unknown = undefined;
        if (typeof init?.body === "string") {
          try {
            parsedBody = JSON.parse(init.body);
          } catch {
            parsedBody = init.body;
          }
        }
        mockPlatformFetchCalls.push({ path, body: parsedBody });

        const idx = mockPlatformFetchCallIndex++;
        const result = mockPlatformFetchResults[idx] ?? {
          ok: false,
          status: 500,
          body: "mock not configured",
        };
        return {
          ok: result.ok,
          status: result.status,
          json: async () => result.body,
          text: async () =>
            typeof result.body === "string"
              ? result.body
              : JSON.stringify(result.body),
        } as unknown as Response;
      },
    };
  },
  fetchActiveConnections: async (
    _client: Record<string, unknown>,
    _provider: string,
    _cmd: Command,
  ): Promise<Array<Record<string, unknown>> | null> => {
    const idx = mockPlatformFetchCallIndex++;
    const result = mockPlatformFetchResults[idx];
    if (!result) return [];
    if (!result.ok) return null;
    return result.body as Array<Record<string, unknown>>;
  },
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks are registered)
// ---------------------------------------------------------------------------

const { registerConnectCommand } = await import("../connect.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = (() => true) as typeof process.stderr.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.option("--json", "JSON output");
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerConnectCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return { exitCode, stdout: stdoutChunks.join("") };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant oauth connect", () => {
  beforeEach(() => {
    mockGetProvider = () => undefined;
    mockGetAppByProviderAndClientId = () => undefined;
    mockGetMostRecentAppByProvider = () => undefined;
    mockOrchestrateOAuthConnect = async () => ({
      success: true,
      deferred: false,
      grantedScopes: [],
    });
    mockGetSecureKeyAsync = async () => undefined;
    mockOpenInBrowserCalls = [];
    mockPlatformClientResult = null;
    mockPlatformFetchResults = [];
    mockPlatformFetchCallIndex = 0;
    mockPlatformFetchCalls = [];
    mockIsManagedMode = () => false;
    delete process.env.IS_CONTAINERIZED;
    mockCliIpcCallFn = async () => ({ ok: false, error: "IPC unavailable" });
    mockLogInfo = () => {};
    process.exitCode = 0;
  });

  // -------------------------------------------------------------------------
  // Unknown provider
  // -------------------------------------------------------------------------

  test("unknown provider returns error with hint", async () => {
    mockGetProvider = () => undefined;

    const { exitCode, stdout } = await runCommand([
      "connect",
      "nonexistent",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Unknown provider");
    expect(parsed.error).toContain("providers list");
  });

  // -------------------------------------------------------------------------
  // Managed mode with --no-browser: prints connect URL
  // -------------------------------------------------------------------------

  test("managed mode with --no-browser: prints connect URL", async () => {
    mockGetProvider = () => ({
      provider: "google",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenExchangeUrl: "https://oauth2.googleapis.com/token",
      tokenExchangeBodyFormat: "form",
      managedServiceConfigKey: "google-oauth",
    });
    mockIsManagedMode = () => true;
    mockPlatformClientResult = { platformAssistantId: "asst-123" };
    mockPlatformFetchResults = [
      {
        ok: true,
        status: 200,
        body: { connect_url: "https://platform.example.com/oauth/connect" },
      },
    ];

    const { exitCode, stdout } = await runCommand([
      "connect",
      "google",
      "--no-browser",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.deferred).toBe(true);
    expect(parsed.connectUrl).toBe(
      "https://platform.example.com/oauth/connect",
    );
    expect(parsed.provider).toBe("google");
  });

  // -------------------------------------------------------------------------
  // Managed mode default: opens browser and polls
  // -------------------------------------------------------------------------

  test("managed mode default: opens browser and polls for new connection", async () => {
    mockGetProvider = () => ({
      provider: "google",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenExchangeUrl: "https://oauth2.googleapis.com/token",
      tokenExchangeBodyFormat: "form",
      managedServiceConfigKey: "google-oauth",
    });
    mockIsManagedMode = () => true;
    mockPlatformClientResult = { platformAssistantId: "asst-123" };

    // First call: /start/ endpoint returns connect_url
    // Second call: fetchActiveConnections snapshot (before browser)
    // Third call: fetchActiveConnections poll (new connection found)
    mockPlatformFetchResults = [
      {
        ok: true,
        status: 200,
        body: { connect_url: "https://platform.example.com/oauth/connect" },
      },
      // Snapshot — empty
      { ok: true, status: 200, body: [] },
      // Poll — new connection appeared
      {
        ok: true,
        status: 200,
        body: [
          {
            id: "conn-new",
            account_label: "user@gmail.com",
            scopes_granted: ["email"],
          },
        ],
      },
    ];

    const { exitCode, stdout } = await runCommand([
      "connect",
      "google",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.connectionId).toBe("conn-new");
    expect(parsed.accountLabel).toBe("user@gmail.com");
    expect(parsed.scopesGranted).toEqual(["email"]);
    expect(mockOpenInBrowserCalls.length).toBeGreaterThanOrEqual(1);
    expect(mockOpenInBrowserCalls[0]).toBe(
      "https://platform.example.com/oauth/connect",
    );
  });

  // -------------------------------------------------------------------------
  // Managed mode: redirect_after_connect contract
  //
  // The CLI must always send an explicit `redirect_after_connect` to the
  // platform's OAuth start endpoint — either a loopback URL (when running
  // on a host with the local redirect server available) or the
  // `/account/oauth/desktop-complete` route. Falling through to the
  // platform's own default lands the browser on a surface that does not
  // render OAuth result params.
  // -------------------------------------------------------------------------

  test("managed mode with --no-browser: sends redirect_after_connect=/account/oauth/desktop-complete", async () => {
    mockGetProvider = () => ({
      provider: "notion",
      authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
      tokenExchangeUrl: "https://api.notion.com/v1/oauth/token",
      tokenExchangeBodyFormat: "form",
      managedServiceConfigKey: "notion-oauth",
    });
    mockIsManagedMode = () => true;
    mockPlatformClientResult = { platformAssistantId: "asst-731" };
    mockPlatformFetchResults = [
      {
        ok: true,
        status: 200,
        body: { connect_url: "https://api.notion.com/v1/oauth/authorize?…" },
      },
    ];

    const { exitCode } = await runCommand([
      "connect",
      "notion",
      "--no-browser",
      "--json",
    ]);
    expect(exitCode).toBe(0);

    const startCall = mockPlatformFetchCalls.find((c) =>
      c.path.includes("/oauth/notion/start/"),
    );
    expect(startCall).toBeDefined();
    const sentBody = startCall!.body as Record<string, unknown>;
    expect(sentBody.redirect_after_connect).toBe(
      "/account/oauth/desktop-complete",
    );
  });

  test("managed mode containerized + browser: sends redirect_after_connect=/account/oauth/desktop-complete", async () => {
    process.env.IS_CONTAINERIZED = "true";

    mockGetProvider = () => ({
      provider: "notion",
      authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
      tokenExchangeUrl: "https://api.notion.com/v1/oauth/token",
      tokenExchangeBodyFormat: "form",
      managedServiceConfigKey: "notion-oauth",
    });
    mockIsManagedMode = () => true;
    mockPlatformClientResult = { platformAssistantId: "asst-731" };
    mockPlatformFetchResults = [
      {
        ok: true,
        status: 200,
        body: { connect_url: "https://api.notion.com/v1/oauth/authorize?…" },
      },
      // Snapshot — empty
      { ok: true, status: 200, body: [] },
      // Poll — new connection appeared
      {
        ok: true,
        status: 200,
        body: [
          {
            id: "conn-new",
            account_label: "user@example.com",
            scopes_granted: [],
          },
        ],
      },
    ];

    const { exitCode } = await runCommand(["connect", "notion", "--json"]);
    expect(exitCode).toBe(0);

    const startCall = mockPlatformFetchCalls.find((c) =>
      c.path.includes("/oauth/notion/start/"),
    );
    expect(startCall).toBeDefined();
    const sentBody = startCall!.body as Record<string, unknown>;
    expect(sentBody.redirect_after_connect).toBe(
      "/account/oauth/desktop-complete",
    );
  });

  test("managed mode default (browser, host): sends loopback redirect_after_connect", async () => {
    mockGetProvider = () => ({
      provider: "notion",
      authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
      tokenExchangeUrl: "https://api.notion.com/v1/oauth/token",
      tokenExchangeBodyFormat: "form",
      managedServiceConfigKey: "notion-oauth",
    });
    mockIsManagedMode = () => true;
    mockPlatformClientResult = { platformAssistantId: "asst-731" };
    mockPlatformFetchResults = [
      {
        ok: true,
        status: 200,
        body: { connect_url: "https://api.notion.com/v1/oauth/authorize?…" },
      },
      // Snapshot — empty
      { ok: true, status: 200, body: [] },
      // Poll — new connection appeared
      {
        ok: true,
        status: 200,
        body: [
          {
            id: "conn-new",
            account_label: "user@example.com",
            scopes_granted: [],
          },
        ],
      },
    ];

    const { exitCode } = await runCommand(["connect", "notion", "--json"]);
    expect(exitCode).toBe(0);

    const startCall = mockPlatformFetchCalls.find((c) =>
      c.path.includes("/oauth/notion/start/"),
    );
    expect(startCall).toBeDefined();
    const sentBody = startCall!.body as Record<string, unknown>;
    const redirect = sentBody.redirect_after_connect as string;
    // Loopback server picks an ephemeral port on localhost and serves the
    // OAuth completion page in-process; the URL shape is stable enough to
    // assert without binding to a specific port.
    expect(redirect).toMatch(/^http:\/\/localhost:\d+\/oauth\/complete$/);
  });

  // -------------------------------------------------------------------------
  // BYO missing app: error with hint
  // -------------------------------------------------------------------------

  test("BYO mode: missing app with --client-id returns error with hint", async () => {
    mockGetProvider = () => ({
      provider: "google",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenExchangeUrl: "https://oauth2.googleapis.com/token",
      tokenExchangeBodyFormat: "form",
      managedServiceConfigKey: null,
    });
    mockIsManagedMode = () => false;
    mockGetAppByProviderAndClientId = () => undefined;

    const { exitCode, stdout } = await runCommand([
      "connect",
      "google",
      "--client-id",
      "nonexistent-id",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("nonexistent-id");
    expect(parsed.error).toContain("apps upsert");
  });

  // -------------------------------------------------------------------------
  // BYO mode: no client_id at all
  // -------------------------------------------------------------------------

  test("BYO mode: no client_id found returns error with hint", async () => {
    mockGetProvider = () => ({
      provider: "google",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenExchangeUrl: "https://oauth2.googleapis.com/token",
      tokenExchangeBodyFormat: "form",
      managedServiceConfigKey: null,
    });
    mockIsManagedMode = () => false;
    mockGetMostRecentAppByProvider = () => undefined;

    const { exitCode, stdout } = await runCommand([
      "connect",
      "google",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("client_id");
    expect(parsed.error).toContain("apps upsert");
  });

  // -------------------------------------------------------------------------
  // --client-id ignored in managed mode (silent, no error)
  // -------------------------------------------------------------------------

  test("--client-id is silently ignored in managed mode", async () => {
    mockGetProvider = () => ({
      provider: "google",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenExchangeUrl: "https://oauth2.googleapis.com/token",
      tokenExchangeBodyFormat: "form",
      managedServiceConfigKey: "google-oauth",
    });
    mockIsManagedMode = () => true;
    mockPlatformClientResult = { platformAssistantId: "asst-123" };
    mockPlatformFetchResults = [
      {
        ok: true,
        status: 200,
        body: { connect_url: "https://platform.example.com/oauth/connect" },
      },
    ];

    const { exitCode, stdout } = await runCommand([
      "connect",
      "google",
      "--client-id",
      "should-be-ignored",
      "--no-browser",
      "--json",
    ]);
    // Should succeed — --client-id does not cause an error in managed mode
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.connectUrl).toBe(
      "https://platform.example.com/oauth/connect",
    );
  });

  // -------------------------------------------------------------------------
  // BYO mode: client_secret required but missing
  // -------------------------------------------------------------------------

  test("BYO mode: client_secret required but missing returns error with hint", async () => {
    mockGetProvider = () => ({
      provider: "google",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenExchangeUrl: "https://oauth2.googleapis.com/token",
      tokenExchangeBodyFormat: "form",
      tokenEndpointAuthMethod: "client_secret_post",
      managedServiceConfigKey: null,
      requiresClientSecret: 1,
    });
    mockIsManagedMode = () => false;

    mockGetMostRecentAppByProvider = () => ({
      id: "app-1",
      clientId: "test-id",
      clientSecretCredentialPath: "oauth_app/app-1/client_secret",
      provider: "google",
      createdAt: 0,
      updatedAt: 0,
    });

    // No secret stored
    mockGetSecureKeyAsync = async () => undefined;

    const { exitCode, stdout } = await runCommand([
      "connect",
      "google",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("client_secret");
    expect(parsed.error).toContain("apps upsert");
  });

  // -------------------------------------------------------------------------
  // Manual-token providers (slack_channel, telegram)
  // -------------------------------------------------------------------------

  test("manual-token provider returns error directing to credentials command", async () => {
    mockGetProvider = () => ({
      provider: "slack_channel",
      authorizeUrl: "urn:manual-token",
      tokenExchangeUrl: "urn:manual-token",
      tokenExchangeBodyFormat: "form",
      managedServiceConfigKey: null,
    });
    mockIsManagedMode = () => false;

    const { exitCode, stdout } = await runCommand([
      "connect",
      "slack_channel",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("manual token configuration");
    expect(parsed.error).toContain("assistant credentials set");
    expect(parsed.error).toContain("--service");
    expect(parsed.error).toContain("--field");
  });

  // -------------------------------------------------------------------------
  // IPC-first path (daemon-orchestrated)
  // -------------------------------------------------------------------------

  describe("IPC-first path (BYO mode via daemon)", () => {
    beforeEach(() => {
      // Set up a valid BYO provider and app for all IPC tests
      mockGetProvider = () => ({
        provider: "google",
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenExchangeUrl: "https://oauth2.googleapis.com/token",
        tokenExchangeBodyFormat: "form",
        managedServiceConfigKey: null,
      });
      mockIsManagedMode = () => false;
      mockGetMostRecentAppByProvider = () => ({
        id: "app-1",
        clientId: "ipc-client-id",
        clientSecretCredentialPath: "oauth_app/app-1/client_secret",
        provider: "google",
        createdAt: 0,
        updatedAt: 0,
      });
    });

    test("IPC start succeeds + polling returns complete → exits 0 with success output", async () => {
      let pollCallCount = 0;
      mockCliIpcCallFn = async (method) => {
        if (method === "internal_oauth_connect_start") {
          return {
            ok: true,
            result: {
              auth_url:
                "https://accounts.google.com/o/oauth2/auth?state=ipc-state",
              state: "ipc-state",
            },
          };
        }
        if (method === "internal_oauth_connect_status") {
          pollCallCount++;
          return {
            ok: true,
            result: {
              status: "complete",
              service: "google",
              account_info: "user@example.com",
            },
          };
        }
        return { ok: false, error: "unexpected method" };
      };

      const { exitCode, stdout } = await runCommand([
        "connect",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.accountInfo).toBe("user@example.com");
      expect(mockOpenInBrowserCalls.length).toBe(1);
      expect(mockOpenInBrowserCalls[0]).toBe(
        "https://accounts.google.com/o/oauth2/auth?state=ipc-state",
      );
      expect(pollCallCount).toBeGreaterThanOrEqual(1);
    });

    test("IPC start succeeds + polling returns error → exits 1 with error message", async () => {
      mockCliIpcCallFn = async (method) => {
        if (method === "internal_oauth_connect_start") {
          return {
            ok: true,
            result: {
              auth_url:
                "https://accounts.google.com/o/oauth2/auth?state=ipc-state",
              state: "ipc-state",
            },
          };
        }
        if (method === "internal_oauth_connect_status") {
          return {
            ok: true,
            result: {
              status: "error",
              service: "google",
              error: "exchange failed",
            },
          };
        }
        return { ok: false, error: "unexpected method" };
      };

      const { exitCode, stdout } = await runCommand([
        "connect",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBe("exchange failed");
    });

    test("IPC start + --no-browser + json → returns deferred JSON without polling status", async () => {
      let statusCallCount = 0;
      mockCliIpcCallFn = async (method) => {
        if (method === "internal_oauth_connect_start") {
          return {
            ok: true,
            result: {
              auth_url:
                "https://accounts.google.com/o/oauth2/auth?state=ipc-state",
              state: "ipc-state",
            },
          };
        }
        if (method === "internal_oauth_connect_status") {
          statusCallCount++;
        }
        return { ok: false, error: "unexpected method" };
      };

      const { exitCode, stdout } = await runCommand([
        "connect",
        "google",
        "--no-browser",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.deferred).toBe(true);
      expect(parsed.authUrl).toBe(
        "https://accounts.google.com/o/oauth2/auth?state=ipc-state",
      );
      expect(parsed.state).toBe("ipc-state");
      expect(parsed.service).toBe("google");
      // Should NOT poll status when --no-browser is set
      expect(statusCallCount).toBe(0);
      // Should NOT open browser
      expect(mockOpenInBrowserCalls.length).toBe(0);
    });

    test("IPC start + --no-browser without json → prints URL to stdout", async () => {
      mockCliIpcCallFn = async (method) => {
        if (method === "internal_oauth_connect_start") {
          return {
            ok: true,
            result: {
              auth_url:
                "https://accounts.google.com/o/oauth2/auth?state=ipc-state",
              state: "ipc-state",
            },
          };
        }
        return { ok: false, error: "unexpected method" };
      };

      const { exitCode, stdout } = await runCommand([
        "connect",
        "google",
        "--no-browser",
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(
        "https://accounts.google.com/o/oauth2/auth?state=ipc-state",
      );
      expect(mockOpenInBrowserCalls.length).toBe(0);
    });

    test("IPC returns ok:false with statusCode → surfaces daemon error, does NOT fall back", async () => {
      // Daemon was reachable but returned an error (e.g. 500)
      mockCliIpcCallFn = async (method) => {
        if (method === "internal_oauth_connect_start") {
          return { ok: false, statusCode: 500, error: "internal server error" };
        }
        return { ok: false, error: "unexpected method" };
      };
      let orchestratorCalled = false;
      mockOrchestrateOAuthConnect = async () => {
        orchestratorCalled = true;
        return { success: true, deferred: false, grantedScopes: [] };
      };

      const { exitCode, stdout } = await runCommand([
        "connect",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      // Must NOT fall back to the in-process orchestrator
      expect(orchestratorCalled).toBe(false);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBe("internal server error");
    });

    test("IPC poll returns ok:false with statusCode → breaks early with error, does NOT wait for timeout", async () => {
      // Fix 1: daemon was reachable during status poll but errored — should surface the
      // error immediately instead of waiting out the full 5-minute timeout.
      mockCliIpcCallFn = async (method) => {
        if (method === "internal_oauth_connect_start") {
          return {
            ok: true,
            result: {
              auth_url:
                "https://accounts.google.com/o/oauth2/auth?state=poll-err-state",
              state: "poll-err-state",
            },
          };
        }
        if (method === "internal_oauth_connect_status") {
          return { ok: false, statusCode: 500, error: "poll error" };
        }
        return { ok: false, error: "unexpected method" };
      };

      const { exitCode, stdout } = await runCommand([
        "connect",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      // The daemon error should be surfaced, not a timeout sentinel
      expect(parsed.error).toBe("poll error");
    });

    test("IPC start returns ok:true with no auth_url → surfaces error, does NOT call in-process orchestrator", async () => {
      // Fix 2: daemon returns { ok: true } but without an auth_url — malformed response
      // should be an error, not a silent fallback to in-process (which has heap-split bug).
      mockCliIpcCallFn = async (method) => {
        if (method === "internal_oauth_connect_start") {
          return { ok: true, result: {} };
        }
        return { ok: false, error: "unexpected method" };
      };
      let orchestratorCalled = false;
      mockOrchestrateOAuthConnect = async () => {
        orchestratorCalled = true;
        return { success: true, deferred: false, grantedScopes: [] };
      };

      const { exitCode, stdout } = await runCommand([
        "connect",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      // Must NOT fall back to the in-process orchestrator
      expect(orchestratorCalled).toBe(false);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("assistant returned unexpected response");
    });

    test("IPC poll: transient ok:false with no statusCode does not abort the flow (continues to next poll)", async () => {
      // Verifies intentional behavior: a single IPC status call returning { ok: false }
      // with NO statusCode (socket error / timeout) is treated as a transient failure and
      // silently retried. Only ok:false WITH a statusCode (i.e., the daemon was reachable
      // and returned an HTTP error) causes an early abort.
      let statusCallCount = 0;
      mockCliIpcCallFn = async (method) => {
        if (method === "internal_oauth_connect_start") {
          return {
            ok: true,
            result: {
              auth_url:
                "https://accounts.google.com/o/oauth2/auth?state=transient-state",
              state: "transient-state",
            },
          };
        }
        if (method === "internal_oauth_connect_status") {
          statusCallCount++;
          if (statusCallCount === 1) {
            // First poll: transient IPC failure (no statusCode — socket error/timeout)
            return { ok: false };
          }
          // Second poll: succeeds
          return {
            ok: true,
            result: {
              status: "complete",
              service: "google",
              account_info: "user@example.com",
            },
          };
        }
        return { ok: false, error: "unexpected method" };
      };

      const { exitCode, stdout } = await runCommand([
        "connect",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.accountInfo).toBe("user@example.com");
      // Both poll calls were made — the transient failure did not abort the loop
      expect(statusCallCount).toBeGreaterThanOrEqual(2);
    });

    test("IPC success path with --json: stdout does NOT contain 'Waiting for authorization' text", async () => {
      // Regression guard for P1: the browser-wait log.info must be suppressed in JSON mode
      // so that machine consumers parsing stdout as JSON don't see corrupted non-JSON output.
      //
      // We configure the logger mock to write to process.stdout (matching the real CLI logger's
      // behavior) so this test would FAIL if the `if (!jsonMode)` guard were removed from connect.ts.
      mockLogInfo = (msg: string) => {
        process.stdout.write(msg + "\n");
      };

      mockCliIpcCallFn = async (method) => {
        if (method === "internal_oauth_connect_start") {
          return {
            ok: true,
            result: {
              auth_url:
                "https://accounts.google.com/o/oauth2/auth?state=json-mode-state",
              state: "json-mode-state",
            },
          };
        }
        if (method === "internal_oauth_connect_status") {
          return {
            ok: true,
            result: {
              status: "complete",
              service: "google",
              account_info: "user@example.com",
            },
          };
        }
        return { ok: false, error: "unexpected method" };
      };

      const { exitCode, stdout } = await runCommand([
        "connect",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      // The suppressed log line must not appear anywhere in stdout
      expect(stdout).not.toContain("Waiting for authorization");
      // stdout must be valid JSON — no plain-text lines mixed in
      expect(() => JSON.parse(stdout)).not.toThrow();
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
    });

    test("IPC start with --callback-transport=gateway passes callbackTransport in body", async () => {
      let capturedParams: Record<string, unknown> | undefined;
      mockCliIpcCallFn = async (method, params) => {
        if (method === "internal_oauth_connect_start") {
          capturedParams = params;
          return {
            ok: true,
            result: {
              auth_url:
                "https://accounts.google.com/o/oauth2/auth?state=gw-state",
              state: "gw-state",
            },
          };
        }
        if (method === "internal_oauth_connect_status") {
          return {
            ok: true,
            result: {
              status: "complete",
              service: "google",
              account_info: "gw-user@example.com",
            },
          };
        }
        return { ok: false, error: "unexpected method" };
      };

      const { exitCode, stdout } = await runCommand([
        "connect",
        "google",
        "--callback-transport",
        "gateway",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      // Verify callbackTransport was forwarded in the IPC body
      expect(capturedParams).toBeDefined();
      expect(
        (capturedParams!.body as Record<string, unknown>).callbackTransport,
      ).toBe("gateway");
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.accountInfo).toBe("gw-user@example.com");
    });
  });
});
