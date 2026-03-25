import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockGetProvider: (
  key: string,
) => Record<string, unknown> | undefined = () => undefined;

let mockListConnections: (
  providerKey: string,
) => Array<Record<string, unknown>> = () => [];

let mockIsManagedMode: (key: string) => boolean = () => false;

let mockPlatformClientResult: Record<string, unknown> | null = null;
let mockPlatformFetchResults: Array<{
  ok: boolean;
  status: number;
  body: unknown;
}> = [];
let mockPlatformFetchCallIndex = 0;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => ({ services: {} }),
  API_KEY_PROVIDERS: [],
}));

mock.module("../../../../oauth/oauth-store.js", () => ({
  getProvider: (key: string) => mockGetProvider(key),
  listConnections: (providerKey: string) => mockListConnections(providerKey),
  getConnection: () => undefined,
  getConnectionByProvider: () => undefined,
  getActiveConnection: () => undefined,
  listActiveConnectionsByProvider: () => [],
  disconnectOAuthProvider: async () => "not-found" as const,
  upsertApp: async () => ({}),
  getApp: () => undefined,
  getAppByProviderAndClientId: () => undefined,
  getMostRecentAppByProvider: () => undefined,
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

mock.module("../../../../oauth/provider-behaviors.js", () => ({
  resolveService: (service: string) => {
    const aliases: Record<string, string> = {
      gmail: "google",
    };
    return aliases[service] ?? service;
  },
  getProviderBehavior: () => undefined,
}));

mock.module("../../../../oauth/connect-orchestrator.js", () => ({
  orchestrateOAuthConnect: async () => ({
    success: true,
    deferred: false,
    grantedScopes: [],
  }),
}));

mock.module("../../../../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => mockPlatformClientResult,
  },
}));

mock.module("../../../../util/browser.js", () => ({
  openInBrowser: () => {},
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
  getSecureKeyViaDaemon: async () => undefined,
  deleteSecureKeyViaDaemon: async () => "not-found" as const,
}));

// Mock shared.js helpers to control managed vs BYO mode routing
mock.module("../shared.js", () => ({
  resolveService: (service: string) => {
    const aliases: Record<string, string> = {
      gmail: "google",
    };
    return aliases[service] ?? service;
  },
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
            "Platform prerequisites not met (not logged in or missing assistant ID)",
        }) + "\n",
      );
      return null;
    }
    return {
      platformAssistantId: (mockPlatformClientResult as Record<string, unknown>)
        .platformAssistantId,
      fetch: async (): Promise<Response> => {
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
  fetchActiveConnections: async (): Promise<Array<
    Record<string, unknown>
  > | null> => {
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

const { registerStatusCommand } = await import("../status.js");

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
    registerStatusCommand(program);
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

describe("assistant oauth status", () => {
  beforeEach(() => {
    mockGetProvider = () => undefined;
    mockListConnections = () => [];
    mockIsManagedMode = () => false;
    mockPlatformClientResult = null;
    mockPlatformFetchResults = [];
    mockPlatformFetchCallIndex = 0;
    process.exitCode = 0;
  });

  // -------------------------------------------------------------------------
  // Unknown provider
  // -------------------------------------------------------------------------

  test("unknown provider returns error", async () => {
    mockGetProvider = () => undefined;

    const { exitCode, stdout } = await runCommand([
      "status",
      "nonexistent",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Unknown provider");
    expect(parsed.error).toContain("providers list");
  });

  // =========================================================================
  // Managed mode tests
  // =========================================================================

  describe("managed mode", () => {
    beforeEach(() => {
      mockGetProvider = () => ({
        providerKey: "google",
        managedServiceConfigKey: "google-oauth",
      });
      mockIsManagedMode = () => true;
      mockPlatformClientResult = { platformAssistantId: "asst-123" };
    });

    test("shows platform connections with account labels", async () => {
      mockPlatformFetchResults = [
        {
          ok: true,
          status: 200,
          body: [
            {
              id: "conn-1",
              account_label: "user@gmail.com",
              scopes_granted: ["email", "calendar"],
              status: "ACTIVE",
            },
            {
              id: "conn-2",
              account_label: "work@company.com",
              scopes_granted: ["email"],
              status: "ACTIVE",
            },
          ],
        },
      ];

      const { exitCode, stdout } = await runCommand([
        "status",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.provider).toBe("google");
      expect(parsed.mode).toBe("managed");
      expect(parsed.connections).toHaveLength(2);

      // Verify connection structure
      const conn1 = parsed.connections[0];
      expect(conn1.id).toBe("conn-1");
      expect(conn1.account).toBe("user@gmail.com");
      expect(conn1.grantedScopes).toEqual(["email", "calendar"]);
      expect(conn1.status).toBe("ACTIVE");

      const conn2 = parsed.connections[1];
      expect(conn2.id).toBe("conn-2");
      expect(conn2.account).toBe("work@company.com");
    });

    test("no connections: empty connections array in JSON", async () => {
      mockPlatformFetchResults = [{ ok: true, status: 200, body: [] }];

      const { exitCode, stdout } = await runCommand([
        "status",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.provider).toBe("google");
      expect(parsed.mode).toBe("managed");
      expect(parsed.connections).toEqual([]);
    });

    test("no connections: human output hints at connect command", async () => {
      mockPlatformFetchResults = [{ ok: true, status: 200, body: [] }];

      // Run without --json to test human output path
      const { exitCode } = await runCommand(["status", "google"]);
      // Should succeed (info message printed via logger, which is mocked)
      expect(exitCode).toBe(0);
    });

    test("JSON output structure matches contract", async () => {
      mockPlatformFetchResults = [
        {
          ok: true,
          status: 200,
          body: [
            {
              id: "conn-abc",
              account_label: null,
              scopes_granted: [],
              status: "ACTIVE",
            },
          ],
        },
      ];

      const { exitCode, stdout } = await runCommand([
        "status",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);

      // Required top-level fields
      expect(parsed).toHaveProperty("ok", true);
      expect(parsed).toHaveProperty("provider");
      expect(parsed).toHaveProperty("mode", "managed");
      expect(parsed).toHaveProperty("connections");
      expect(Array.isArray(parsed.connections)).toBe(true);

      // Required per-connection fields
      const conn = parsed.connections[0];
      expect(conn).toHaveProperty("id");
      expect(conn).toHaveProperty("account");
      expect(conn).toHaveProperty("grantedScopes");
      expect(conn).toHaveProperty("status");
    });
  });

  // =========================================================================
  // BYO mode tests
  // =========================================================================

  describe("BYO mode", () => {
    beforeEach(() => {
      mockGetProvider = () => ({
        providerKey: "google",
        managedServiceConfigKey: null,
      });
      mockIsManagedMode = () => false;
    });

    test("shows local connections with expiry and refresh info", async () => {
      const expiresAt = Date.now() + 3600_000; // 1 hour from now
      mockListConnections = () => [
        {
          id: "conn-local-1",
          providerKey: "google",
          accountInfo: "localuser@gmail.com",
          grantedScopes: '["email","profile"]',
          expiresAt,
          hasRefreshToken: 1,
          status: "active",
        },
      ];

      const { exitCode, stdout } = await runCommand([
        "status",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.provider).toBe("google");
      expect(parsed.mode).toBe("byo");
      expect(parsed.connections).toHaveLength(1);

      const conn = parsed.connections[0];
      expect(conn.id).toBe("conn-local-1");
      expect(conn.account).toBe("localuser@gmail.com");
      expect(conn.grantedScopes).toEqual(["email", "profile"]);
      expect(conn.expiresAt).toBeTruthy();
      expect(conn.hasRefreshToken).toBe(true);
      expect(conn.status).toBe("active");
    });

    test("shows connection with no refresh token", async () => {
      mockListConnections = () => [
        {
          id: "conn-local-2",
          providerKey: "google",
          accountInfo: null,
          grantedScopes: "[]",
          expiresAt: null,
          hasRefreshToken: 0,
          status: "active",
        },
      ];

      const { exitCode, stdout } = await runCommand([
        "status",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      const conn = parsed.connections[0];
      expect(conn.account).toBeNull();
      expect(conn.expiresAt).toBeNull();
      expect(conn.hasRefreshToken).toBe(false);
    });

    test("filters to only active connections", async () => {
      mockListConnections = () => [
        {
          id: "conn-active",
          providerKey: "google",
          accountInfo: "user@gmail.com",
          grantedScopes: "[]",
          expiresAt: null,
          hasRefreshToken: 0,
          status: "active",
        },
        {
          id: "conn-revoked",
          providerKey: "google",
          accountInfo: "old@gmail.com",
          grantedScopes: "[]",
          expiresAt: null,
          hasRefreshToken: 0,
          status: "revoked",
        },
      ];

      const { exitCode, stdout } = await runCommand([
        "status",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.connections).toHaveLength(1);
      expect(parsed.connections[0].id).toBe("conn-active");
    });

    test("no connections: empty array in JSON output", async () => {
      mockListConnections = () => [];

      const { exitCode, stdout } = await runCommand([
        "status",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.provider).toBe("google");
      expect(parsed.mode).toBe("byo");
      expect(parsed.connections).toEqual([]);
    });

    test("no connections: human output hints at connect command", async () => {
      mockListConnections = () => [];

      // Run without --json — the human output path logs via getCliLogger
      const { exitCode } = await runCommand(["status", "google"]);
      expect(exitCode).toBe(0);
    });

    test("JSON output structure matches contract", async () => {
      mockListConnections = () => [
        {
          id: "conn-structure",
          providerKey: "google",
          accountInfo: "check@gmail.com",
          grantedScopes: '["scope1"]',
          expiresAt: Date.now() + 60_000,
          hasRefreshToken: 1,
          status: "active",
        },
      ];

      const { exitCode, stdout } = await runCommand([
        "status",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);

      // Required top-level fields
      expect(parsed).toHaveProperty("ok", true);
      expect(parsed).toHaveProperty("provider");
      expect(parsed).toHaveProperty("mode", "byo");
      expect(parsed).toHaveProperty("connections");
      expect(Array.isArray(parsed.connections)).toBe(true);

      // Required per-connection fields for BYO
      const conn = parsed.connections[0];
      expect(conn).toHaveProperty("id");
      expect(conn).toHaveProperty("account");
      expect(conn).toHaveProperty("grantedScopes");
      expect(conn).toHaveProperty("expiresAt");
      expect(conn).toHaveProperty("hasRefreshToken");
      expect(conn).toHaveProperty("status");
    });

    test("handles malformed grantedScopes JSON gracefully", async () => {
      mockListConnections = () => [
        {
          id: "conn-bad-scopes",
          providerKey: "google",
          accountInfo: null,
          grantedScopes: "not-valid-json",
          expiresAt: null,
          hasRefreshToken: 0,
          status: "active",
        },
      ];

      const { exitCode, stdout } = await runCommand([
        "status",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      // Should default to empty array on parse failure
      expect(parsed.connections[0].grantedScopes).toEqual([]);
    });
  });
});
