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

let mockGetSecureKeyViaDaemon: (
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

let mockIsManagedMode: (key: string) => boolean = () => false;

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
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

mock.module("../../../lib/daemon-credential-client.js", () => ({
  getSecureKeyViaDaemon: (account: string) =>
    mockGetSecureKeyViaDaemon(account),
  deleteSecureKeyViaDaemon: async () => "not-found" as const,
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
      fetch: async (_path: string, _init?: RequestInit): Promise<Response> => {
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
    mockGetSecureKeyViaDaemon = async () => undefined;
    mockOpenInBrowserCalls = [];
    mockPlatformClientResult = null;
    mockPlatformFetchResults = [];
    mockPlatformFetchCallIndex = 0;
    mockIsManagedMode = () => false;
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
  // BYO mode with --no-browser: prints auth URL (deferred)
  // -------------------------------------------------------------------------

  test("BYO mode with --no-browser: prints auth URL", async () => {
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
      clientId: "byo-client-id",
      clientSecretCredentialPath: "oauth_app/app-1/client_secret",
      provider: "google",
      createdAt: 0,
      updatedAt: 0,
    });

    mockOrchestrateOAuthConnect = async () => ({
      success: true,
      deferred: true,
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
      state: "abc",
      service: "google",
    });

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
      "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
    );
    expect(parsed.service).toBe("google");
  });

  // -------------------------------------------------------------------------
  // BYO mode default: orchestrator called with isInteractive true
  // -------------------------------------------------------------------------

  test("BYO mode default calls orchestrator with isInteractive: true", async () => {
    mockGetProvider = () => ({
      provider: "google",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenExchangeUrl: "https://oauth2.googleapis.com/token",
      tokenExchangeBodyFormat: "form",
      managedServiceConfigKey: null,
    });
    mockIsManagedMode = () => false;

    mockGetAppByProviderAndClientId = () => ({
      id: "app-1",
      clientId: "test-id",
      clientSecretCredentialPath: "oauth_app/app-1/client_secret",
      provider: "google",
      createdAt: 0,
      updatedAt: 0,
    });

    let capturedOpts: Record<string, unknown> | undefined;
    mockOrchestrateOAuthConnect = async (opts) => {
      capturedOpts = opts;
      return {
        success: true,
        deferred: false,
        grantedScopes: ["email"],
        accountInfo: "user@example.com",
      };
    };

    const { exitCode, stdout } = await runCommand([
      "connect",
      "google",
      "--client-id",
      "test-id",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts!.isInteractive).toBe(true);
    // openUrl should be provided by default (browser opens automatically)
    expect(typeof capturedOpts!.openUrl).toBe("function");

    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.grantedScopes).toEqual(["email"]);
    expect(parsed.accountInfo).toBe("user@example.com");
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
  // JSON output format for deferred case (BYO)
  // -------------------------------------------------------------------------

  test("JSON output for deferred case includes ok, deferred, authUrl, service", async () => {
    mockGetProvider = () => ({
      provider: "slack",
      authorizeUrl: "https://slack.com/oauth/v2/authorize",
      tokenExchangeUrl: "https://slack.com/api/oauth.v2.access",
      tokenExchangeBodyFormat: "form",
      managedServiceConfigKey: null,
    });
    mockIsManagedMode = () => false;

    mockGetMostRecentAppByProvider = () => ({
      id: "app-slack",
      clientId: "slack-client-id",
      clientSecretCredentialPath: "oauth_app/app-slack/client_secret",
      provider: "slack",
      createdAt: 0,
      updatedAt: 0,
    });

    mockOrchestrateOAuthConnect = async () => ({
      success: true,
      deferred: true,
      authorizeUrl: "https://slack.com/oauth/v2/authorize?state=xyz",
      state: "xyz",
      service: "slack",
    });

    const { exitCode, stdout } = await runCommand([
      "connect",
      "slack",
      "--no-browser",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("ok", true);
    expect(parsed).toHaveProperty("deferred", true);
    expect(parsed).toHaveProperty("authUrl");
    expect(parsed).toHaveProperty("service", "slack");
  });

  // -------------------------------------------------------------------------
  // JSON output format for completed case (BYO)
  // -------------------------------------------------------------------------

  test("JSON output for completed case includes ok, grantedScopes, accountInfo", async () => {
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
      clientId: "completed-client-id",
      clientSecretCredentialPath: "oauth_app/app-1/client_secret",
      provider: "google",
      createdAt: 0,
      updatedAt: 0,
    });

    mockOrchestrateOAuthConnect = async () => ({
      success: true,
      deferred: false,
      grantedScopes: ["email", "profile"],
      accountInfo: "test@gmail.com",
    });

    const { exitCode, stdout } = await runCommand([
      "connect",
      "google",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("ok", true);
    expect(parsed).toHaveProperty("grantedScopes");
    expect(parsed.grantedScopes).toEqual(["email", "profile"]);
    expect(parsed).toHaveProperty("accountInfo", "test@gmail.com");
    // Should NOT have deferred
    expect(parsed.deferred).toBeUndefined();
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
    mockGetSecureKeyViaDaemon = async () => undefined;

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
  // Orchestrator error propagation
  // -------------------------------------------------------------------------

  test("BYO mode: orchestrator error propagates correctly", async () => {
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
      clientId: "client-id",
      clientSecretCredentialPath: "oauth_app/app-1/client_secret",
      provider: "google",
      createdAt: 0,
      updatedAt: 0,
    });

    mockOrchestrateOAuthConnect = async () => ({
      success: false,
      error: "Token exchange failed: invalid_grant",
    });

    const { exitCode, stdout } = await runCommand([
      "connect",
      "google",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("Token exchange failed: invalid_grant");
  });
});
