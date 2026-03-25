import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockGetProvider: (
  key: string,
) => Record<string, unknown> | undefined = () => undefined;

let mockGetConnection: (
  id: string,
) => Record<string, unknown> | undefined = () => undefined;

let mockGetActiveConnection: (
  providerKey: string,
  opts?: { account?: string },
) => Record<string, unknown> | undefined = () => undefined;

let mockListActiveConnectionsByProvider: (
  providerKey: string,
) => Array<Record<string, unknown>> = () => [];

let mockDisconnectOAuthProviderResult: "disconnected" | "not-found" | "error" =
  "disconnected";

let mockDisconnectOAuthProviderCalls: Array<{
  providerKey: string;
  account: string | undefined;
  connectionId: string | undefined;
}> = [];

let mockDeleteSecureKeyViaDaemonCalls: Array<{
  type: string;
  name: string;
}> = [];

let mockDeleteCredentialMetadataCalls: Array<{
  service: string;
  field: string;
}> = [];

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
  getConnection: (id: string) => mockGetConnection(id),
  getActiveConnection: (providerKey: string, opts?: { account?: string }) =>
    mockGetActiveConnection(providerKey, opts),
  listActiveConnectionsByProvider: (providerKey: string) =>
    mockListActiveConnectionsByProvider(providerKey),
  disconnectOAuthProvider: async (
    providerKey: string,
    account?: string,
    connectionId?: string,
  ) => {
    mockDisconnectOAuthProviderCalls.push({
      providerKey,
      account,
      connectionId,
    });
    return mockDisconnectOAuthProviderResult;
  },
  getConnectionByProvider: () => undefined,
  listConnections: () => [],
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

mock.module("../../../../tools/credentials/metadata-store.js", () => ({
  deleteCredentialMetadata: (service: string, field: string) => {
    mockDeleteCredentialMetadataCalls.push({ service, field });
    return true;
  },
  getCredentialMetadata: () => undefined,
  upsertCredentialMetadata: () => ({}),
  listCredentialMetadata: () => [],
  assertMetadataWritable: () => {},
}));

mock.module("../../../lib/daemon-credential-client.js", () => ({
  getSecureKeyViaDaemon: async () => undefined,
  deleteSecureKeyViaDaemon: async (type: string, name: string) => {
    mockDeleteSecureKeyViaDaemonCalls.push({ type, name });
    return "deleted" as const;
  },
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

const { registerDisconnectCommand } = await import("../disconnect.js");

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
    registerDisconnectCommand(program);
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

describe("assistant oauth disconnect", () => {
  beforeEach(() => {
    mockGetProvider = () => undefined;
    mockGetConnection = () => undefined;
    mockGetActiveConnection = () => undefined;
    mockListActiveConnectionsByProvider = () => [];
    mockDisconnectOAuthProviderResult = "disconnected";
    mockDisconnectOAuthProviderCalls = [];
    mockDeleteSecureKeyViaDaemonCalls = [];
    mockDeleteCredentialMetadataCalls = [];
    mockIsManagedMode = () => false;
    mockPlatformClientResult = null;
    mockPlatformFetchResults = [];
    mockPlatformFetchCallIndex = 0;
    process.exitCode = 0;
  });

  // -------------------------------------------------------------------------
  // Unknown provider
  // -------------------------------------------------------------------------

  test("unknown provider returns error with hint", async () => {
    mockGetProvider = () => undefined;

    const { exitCode, stdout } = await runCommand([
      "disconnect",
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
  // Both --account and --connection-id → error
  // -------------------------------------------------------------------------

  test("both --account and --connection-id returns error", async () => {
    mockGetProvider = () => ({
      providerKey: "google",
      managedServiceConfigKey: null,
    });

    const { exitCode, stdout } = await runCommand([
      "disconnect",
      "google",
      "--account",
      "user@example.com",
      "--connection-id",
      "conn-123",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Cannot specify both");
    expect(parsed.error).toContain("--account");
    expect(parsed.error).toContain("--connection-id");
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

    test("single connection auto-disconnects", async () => {
      mockPlatformFetchResults = [
        // fetchActiveConnections returns one connection
        {
          ok: true,
          status: 200,
          body: [
            {
              id: "conn-1",
              account_label: "user@gmail.com",
              scopes_granted: ["email"],
            },
          ],
        },
        // disconnect call succeeds
        { ok: true, status: 200, body: {} },
      ];

      const { exitCode, stdout } = await runCommand([
        "disconnect",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.provider).toBe("google");
      expect(parsed.connectionId).toBe("conn-1");
      expect(parsed.account).toBe("user@gmail.com");
    });

    test("multiple connections without flag returns error with connection list", async () => {
      mockPlatformFetchResults = [
        {
          ok: true,
          status: 200,
          body: [
            {
              id: "conn-1",
              account_label: "user1@gmail.com",
              scopes_granted: [],
            },
            {
              id: "conn-2",
              account_label: "user2@gmail.com",
              scopes_granted: [],
            },
          ],
        },
      ];

      const { exitCode, stdout } = await runCommand([
        "disconnect",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Multiple active connections");
      expect(parsed.error).toContain("--account");
      expect(parsed.error).toContain("--connection-id");
      expect(parsed.connections).toBeDefined();
      expect(parsed.connections).toHaveLength(2);
    });

    test("--account filters correctly", async () => {
      mockPlatformFetchResults = [
        {
          ok: true,
          status: 200,
          body: [
            {
              id: "conn-1",
              account_label: "user1@gmail.com",
              scopes_granted: [],
            },
            {
              id: "conn-2",
              account_label: "user2@gmail.com",
              scopes_granted: [],
            },
          ],
        },
        // disconnect call succeeds
        { ok: true, status: 200, body: {} },
      ];

      const { exitCode, stdout } = await runCommand([
        "disconnect",
        "google",
        "--account",
        "user2@gmail.com",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.connectionId).toBe("conn-2");
      expect(parsed.account).toBe("user2@gmail.com");
    });

    test("--connection-id validates ownership", async () => {
      mockPlatformFetchResults = [
        {
          ok: true,
          status: 200,
          body: [
            {
              id: "conn-1",
              account_label: "user@gmail.com",
              scopes_granted: [],
            },
          ],
        },
      ];

      const { exitCode, stdout } = await runCommand([
        "disconnect",
        "google",
        "--connection-id",
        "conn-nonexistent",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("conn-nonexistent");
      expect(parsed.error).toContain("not an active");
    });

    test("no connections returns error with hint", async () => {
      mockPlatformFetchResults = [{ ok: true, status: 200, body: [] }];

      const { exitCode, stdout } = await runCommand([
        "disconnect",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("No active connections");
      expect(parsed.error).toContain("status");
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

    test("single connection auto-disconnects", async () => {
      mockListActiveConnectionsByProvider = () => [
        {
          id: "conn-1",
          providerKey: "google",
          accountInfo: "user@gmail.com",
          status: "active",
        },
      ];

      const { exitCode, stdout } = await runCommand([
        "disconnect",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.provider).toBe("google");
      expect(parsed.connectionId).toBe("conn-1");
      expect(parsed.account).toBe("user@gmail.com");

      // Verify disconnectOAuthProvider was called
      expect(mockDisconnectOAuthProviderCalls).toHaveLength(1);
      expect(mockDisconnectOAuthProviderCalls[0].providerKey).toBe("google");
      expect(mockDisconnectOAuthProviderCalls[0].connectionId).toBe("conn-1");
    });

    test("--account matches accountInfo", async () => {
      mockGetActiveConnection = (providerKey, opts) => {
        if (opts?.account === "user@gmail.com") {
          return {
            id: "conn-1",
            providerKey: "google",
            accountInfo: "user@gmail.com",
            status: "active",
          };
        }
        return undefined;
      };

      const { exitCode, stdout } = await runCommand([
        "disconnect",
        "google",
        "--account",
        "user@gmail.com",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.connectionId).toBe("conn-1");
      expect(parsed.account).toBe("user@gmail.com");
    });

    test("--account with no match returns error", async () => {
      mockGetActiveConnection = () => undefined;

      const { exitCode, stdout } = await runCommand([
        "disconnect",
        "google",
        "--account",
        "nonexistent@gmail.com",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("No active connection");
      expect(parsed.error).toContain("nonexistent@gmail.com");
    });

    test("--connection-id looks up by ID", async () => {
      mockGetConnection = (id) => {
        if (id === "conn-123") {
          return {
            id: "conn-123",
            providerKey: "google",
            accountInfo: "user@gmail.com",
            status: "active",
          };
        }
        return undefined;
      };

      const { exitCode, stdout } = await runCommand([
        "disconnect",
        "google",
        "--connection-id",
        "conn-123",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.connectionId).toBe("conn-123");
    });

    test("--connection-id with wrong provider returns error", async () => {
      mockGetConnection = (id) => {
        if (id === "conn-slack") {
          return {
            id: "conn-slack",
            providerKey: "slack",
            accountInfo: null,
            status: "active",
          };
        }
        return undefined;
      };

      const { exitCode, stdout } = await runCommand([
        "disconnect",
        "google",
        "--connection-id",
        "conn-slack",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("conn-slack");
      expect(parsed.error).toContain("not an active");
    });

    test("multiple connections without flags returns error with list", async () => {
      mockListActiveConnectionsByProvider = () => [
        {
          id: "conn-1",
          providerKey: "google",
          accountInfo: "user1@gmail.com",
          status: "active",
        },
        {
          id: "conn-2",
          providerKey: "google",
          accountInfo: "user2@gmail.com",
          status: "active",
        },
      ];

      const { exitCode, stdout } = await runCommand([
        "disconnect",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Multiple active connections");
      expect(parsed.error).toContain("--account");
      expect(parsed.error).toContain("--connection-id");
      expect(parsed.connections).toBeDefined();
      expect(parsed.connections).toHaveLength(2);
    });

    test("no connections returns error with hint", async () => {
      mockListActiveConnectionsByProvider = () => [];

      const { exitCode, stdout } = await runCommand([
        "disconnect",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("No active connections");
      expect(parsed.error).toContain("status");
    });

    test("disconnect error returns error message", async () => {
      mockDisconnectOAuthProviderResult = "error";
      mockListActiveConnectionsByProvider = () => [
        {
          id: "conn-1",
          providerKey: "google",
          accountInfo: null,
          status: "active",
        },
      ];

      const { exitCode, stdout } = await runCommand([
        "disconnect",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Failed to disconnect");
    });
  });
});
