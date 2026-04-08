import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockGetProvider: (
  key: string,
) => Record<string, unknown> | undefined = () => undefined;

let mockDeleteProviderResult = false;

let mockListAppsResult: Array<Record<string, unknown>> = [];

let mockListConnectionsResult: Array<Record<string, unknown>> = [];

let mockDeleteAppCalls: string[] = [];
let mockDeleteAppResult = true;

let mockDisconnectCalls: Array<{
  provider: string;
  clientId: string | undefined;
  connectionId: string | undefined;
}> = [];
let mockDisconnectResult: "disconnected" | "not-found" | "error" =
  "disconnected";

let mockDeleteConnectionCalls: Array<string | number> = [];

let mockSeededProviderKeys = new Set<string>(["google", "slack", "github"]);

let mockLogInfoCalls: string[] = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => ({ services: {} }),
  loadConfig: () => ({ services: {} }),
  API_KEY_PROVIDERS: [],
}));

mock.module("../../../../oauth/oauth-store.js", () => ({
  getProvider: (key: string) => mockGetProvider(key),
  deleteProvider: () => mockDeleteProviderResult,
  listApps: () => mockListAppsResult,
  listConnections: (provider?: string) => {
    if (provider) {
      return mockListConnectionsResult.filter((c) => c.provider === provider);
    }
    return mockListConnectionsResult;
  },
  deleteApp: async (id: string) => {
    mockDeleteAppCalls.push(id);
    return mockDeleteAppResult;
  },
  disconnectOAuthProvider: async (
    provider: string,
    clientId?: string,
    connectionId?: string,
  ) => {
    mockDisconnectCalls.push({ provider, clientId, connectionId });
    return mockDisconnectResult;
  },
  listProviders: () => [],
  registerProvider: () => ({}),
  seedProviders: () => {},
  upsertApp: async () => ({}),
  getApp: () => undefined,
  getAppByProviderAndClientId: () => undefined,
  getMostRecentAppByProvider: () => undefined,
  createConnection: () => ({}),
  updateConnection: () => ({}),
  getConnection: () => undefined,
  getActiveConnection: () => undefined,
  getConnectionByProvider: () => undefined,
  listActiveConnectionsByProvider: () => [],
  isProviderConnected: () => false,
  deleteConnection: (id: string | number) => {
    mockDeleteConnectionCalls.push(id);
    return true;
  },
}));

mock.module("../../../../oauth/seed-providers.js", () => ({
  SEEDED_PROVIDER_KEYS: mockSeededProviderKeys,
  seedOAuthProviders: () => {},
}));

mock.module("../../../../inbound/public-ingress-urls.js", () => ({
  getOAuthCallbackUrl: () => null,
}));

mock.module("../../../../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: (msg: string) => {
      mockLogInfoCalls.push(msg);
    },
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks are registered)
// ---------------------------------------------------------------------------

const { registerProviderCommands } = await import("../providers.js");

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
    registerProviderCommands(program);
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

describe("assistant oauth providers delete", () => {
  beforeEach(() => {
    mockGetProvider = () => undefined;
    mockDeleteProviderResult = true;
    mockListAppsResult = [];
    mockListConnectionsResult = [];
    mockDeleteAppCalls = [];
    mockDeleteAppResult = true;
    mockDisconnectCalls = [];
    mockDisconnectResult = "disconnected";
    mockDeleteConnectionCalls = [];
    mockSeededProviderKeys = new Set(["google", "slack", "github"]);
    mockLogInfoCalls = [];
    process.exitCode = 0;
  });

  // -------------------------------------------------------------------------
  // Provider not found
  // -------------------------------------------------------------------------

  test("provider not found returns exit code 1 with actionable error", async () => {
    mockGetProvider = () => undefined;

    const { exitCode, stdout } = await runCommand([
      "providers",
      "delete",
      "nonexistent",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("not found");
    expect(parsed.error).toContain("nonexistent");
    expect(parsed.error).toContain("providers list");
  });

  // -------------------------------------------------------------------------
  // Provider with dependents, no --force
  // -------------------------------------------------------------------------

  test("provider with dependents and no --force returns exit code 1 with counts", async () => {
    mockGetProvider = (key) =>
      key === "custom-api"
        ? { provider: "custom-api", authorizeUrl: "https://example.com/auth" }
        : undefined;

    mockListAppsResult = [
      {
        id: "app-1",
        provider: "custom-api",
        clientId: "c1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "app-2",
        provider: "custom-api",
        clientId: "c2",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    mockListConnectionsResult = [
      {
        id: "conn-1",
        provider: "custom-api",
        oauthAppId: "app-1",
        status: "active",
      },
      {
        id: "conn-2",
        provider: "custom-api",
        oauthAppId: "app-1",
        status: "active",
      },
      {
        id: "conn-3",
        provider: "custom-api",
        oauthAppId: "app-2",
        status: "active",
      },
    ];

    const { exitCode, stdout } = await runCommand([
      "providers",
      "delete",
      "custom-api",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("2 app(s)");
    expect(parsed.error).toContain("3 connection(s)");
    expect(parsed.error).toContain("--force");
  });

  // -------------------------------------------------------------------------
  // Provider with dependents, --force
  // -------------------------------------------------------------------------

  test("provider with dependents and --force cascades deletion and returns summary", async () => {
    mockGetProvider = (key) =>
      key === "custom-api"
        ? { provider: "custom-api", authorizeUrl: "https://example.com/auth" }
        : undefined;

    mockListAppsResult = [
      {
        id: "app-1",
        provider: "custom-api",
        clientId: "c1",
        clientSecretCredentialPath: "cred/app-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "app-other",
        provider: "other-provider",
        clientId: "c3",
        clientSecretCredentialPath: "cred/app-other",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    mockListConnectionsResult = [
      {
        id: "conn-1",
        provider: "custom-api",
        oauthAppId: "app-1",
        status: "active",
      },
      {
        id: "conn-2",
        provider: "custom-api",
        oauthAppId: "app-1",
        status: "active",
      },
    ];

    const { exitCode, stdout } = await runCommand([
      "providers",
      "delete",
      "custom-api",
      "--force",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.deleted.provider).toBe(1);
    expect(parsed.deleted.apps).toBe(1); // Only custom-api apps, not other-provider
    expect(parsed.deleted.connections).toBe(2);

    // Verify disconnectOAuthProvider was called for each connection
    expect(mockDisconnectCalls).toEqual([
      {
        provider: "custom-api",
        clientId: undefined,
        connectionId: "conn-1",
      },
      {
        provider: "custom-api",
        clientId: undefined,
        connectionId: "conn-2",
      },
    ]);

    // Verify only matching apps were deleted (not app-other)
    expect(mockDeleteAppCalls).toEqual(["app-1"]);
  });

  // -------------------------------------------------------------------------
  // Provider with no dependents, no --force
  // -------------------------------------------------------------------------

  test("provider with no dependents and no --force deletes cleanly", async () => {
    mockGetProvider = (key) =>
      key === "custom-api"
        ? { provider: "custom-api", authorizeUrl: "https://example.com/auth" }
        : undefined;

    mockListAppsResult = [];
    mockListConnectionsResult = [];

    const { exitCode, stdout } = await runCommand([
      "providers",
      "delete",
      "custom-api",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.deleted.provider).toBe(1);
    expect(parsed.deleted.apps).toBe(0);
    expect(parsed.deleted.connections).toBe(0);

    // No cascade deletes should have happened
    expect(mockDisconnectCalls).toHaveLength(0);
    expect(mockDeleteAppCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Built-in provider with --force logs warning
  // -------------------------------------------------------------------------

  test("built-in provider with --force succeeds and logs warning about re-creation", async () => {
    mockGetProvider = (key) =>
      key === "google"
        ? { provider: "google", authorizeUrl: "https://accounts.google.com" }
        : undefined;

    mockListAppsResult = [
      {
        id: "app-g",
        provider: "google",
        clientId: "goog-client",
        clientSecretCredentialPath: "cred/app-g",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    mockListConnectionsResult = [
      {
        id: "conn-g",
        provider: "google",
        oauthAppId: "app-g",
        status: "active",
      },
    ];

    const { exitCode, stdout } = await runCommand([
      "providers",
      "delete",
      "google",
      "--force",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.deleted.provider).toBe(1);
    expect(parsed.deleted.apps).toBe(1);
    expect(parsed.deleted.connections).toBe(1);

    // Should have logged a warning about re-creation
    const warningLogged = mockLogInfoCalls.some(
      (msg) => msg.includes("built-in") && msg.includes("re-created"),
    );
    expect(warningLogged).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Built-in provider without --force and no dependents logs warning
  // -------------------------------------------------------------------------

  test("built-in provider without --force and no dependents logs warning and deletes", async () => {
    mockGetProvider = (key) =>
      key === "google"
        ? { provider: "google", authorizeUrl: "https://accounts.google.com" }
        : undefined;

    mockListAppsResult = [];
    mockListConnectionsResult = [];

    const { exitCode, stdout } = await runCommand([
      "providers",
      "delete",
      "google",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.deleted.provider).toBe(1);

    // Should have logged a warning about re-creation
    const warningLogged = mockLogInfoCalls.some(
      (msg) => msg.includes("built-in") && msg.includes("re-created"),
    );
    expect(warningLogged).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Token cleanup error is logged but does not abort cascade
  // -------------------------------------------------------------------------

  test("token cleanup error logs warning but continues cascade delete", async () => {
    mockGetProvider = (key) =>
      key === "custom-api"
        ? { provider: "custom-api", authorizeUrl: "https://example.com/auth" }
        : undefined;

    mockListAppsResult = [
      {
        id: "app-1",
        provider: "custom-api",
        clientId: "c1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    mockListConnectionsResult = [
      {
        id: "conn-1",
        provider: "custom-api",
        oauthAppId: "app-1",
        status: "active",
      },
    ];

    // Simulate token cleanup failure
    mockDisconnectResult = "error";

    const { exitCode, stdout } = await runCommand([
      "providers",
      "delete",
      "custom-api",
      "--force",
      "--json",
    ]);
    // Should still succeed despite token cleanup error
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.deleted.provider).toBe(1);
    expect(parsed.deleted.connections).toBe(1);

    // Should have logged a warning about the token cleanup failure
    const warningLogged = mockLogInfoCalls.some(
      (msg) =>
        msg.includes("failed to clean up tokens") && msg.includes("conn-1"),
    );
    expect(warningLogged).toBe(true);

    // Should have called deleteConnection as a fallback
    expect(mockDeleteConnectionCalls).toEqual(["conn-1"]);
  });

  // -------------------------------------------------------------------------
  // Token cleanup error falls back to deleteConnection
  // -------------------------------------------------------------------------

  test("token cleanup error calls deleteConnection as fallback to avoid FK violation", async () => {
    mockGetProvider = (key) =>
      key === "custom-api"
        ? { provider: "custom-api", authorizeUrl: "https://example.com/auth" }
        : undefined;

    mockListAppsResult = [
      {
        id: "app-1",
        provider: "custom-api",
        clientId: "c1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    mockListConnectionsResult = [
      {
        id: "conn-1",
        provider: "custom-api",
        oauthAppId: "app-1",
        status: "active",
      },
      {
        id: "conn-2",
        provider: "custom-api",
        oauthAppId: "app-1",
        status: "active",
      },
    ];

    // Simulate token cleanup failure for all connections
    mockDisconnectResult = "error";

    const { exitCode, stdout } = await runCommand([
      "providers",
      "delete",
      "custom-api",
      "--force",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);

    // Both disconnectOAuthProvider calls should have been made
    expect(mockDisconnectCalls).toHaveLength(2);
    expect(mockDisconnectCalls[0]!.connectionId).toBe("conn-1");
    expect(mockDisconnectCalls[1]!.connectionId).toBe("conn-2");

    // Both should have fallen back to deleteConnection
    expect(mockDeleteConnectionCalls).toEqual(["conn-1", "conn-2"]);

    // Apps should still have been deleted after connections were cleaned up
    expect(mockDeleteAppCalls).toEqual(["app-1"]);
  });
});
