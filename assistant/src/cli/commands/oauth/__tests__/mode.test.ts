import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockGetProvider: (
  key: string,
) => Record<string, unknown> | undefined = () => undefined;

let mockListActiveConnectionsByProvider: (
  providerKey: string,
) => Array<Record<string, unknown>> = () => [];

let mockGetManagedServiceConfigKey: (key: string) => string | null = () => null;

let mockPlatformClientResult: Record<string, unknown> | null = null;
let mockPlatformFetchResults: Array<{
  ok: boolean;
  status: number;
  body: unknown;
}> = [];
let mockPlatformFetchCallIndex = 0;

let mockRawConfig: Record<string, unknown> = {};
let mockSaveRawConfigCalls: Array<Record<string, unknown>> = [];
let mockSetNestedValueCalls: Array<{
  obj: Record<string, unknown>;
  path: string;
  value: unknown;
}> = [];

let mockConfigServices: Record<string, unknown> = {};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => ({ services: mockConfigServices }),
  loadRawConfig: () => mockRawConfig,
  saveRawConfig: (config: Record<string, unknown>) => {
    mockSaveRawConfigCalls.push(structuredClone(config));
  },
  setNestedValue: (
    obj: Record<string, unknown>,
    path: string,
    value: unknown,
  ) => {
    mockSetNestedValueCalls.push({ obj, path, value });
    // Actually set the value so the mock raw config is mutated
    const keys = path.split(".");
    let current: Record<string, unknown> = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (current[key] == null || typeof current[key] !== "object") {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }
    current[keys[keys.length - 1]] = value;
  },
  API_KEY_PROVIDERS: [],
}));

mock.module("../../../../oauth/oauth-store.js", () => ({
  getProvider: (key: string) => mockGetProvider(key),
  listActiveConnectionsByProvider: (providerKey: string) =>
    mockListActiveConnectionsByProvider(providerKey),
  listConnections: () => [],
  getConnection: () => undefined,
  getConnectionByProvider: () => undefined,
  getActiveConnection: () => undefined,
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
      gmail: "integration:google",
      google: "integration:google",
      slack: "integration:slack",
    };
    if (aliases[service]) return aliases[service];
    if (!service.includes(":")) return `integration:${service}`;
    return service;
  },
  getProviderBehavior: () => undefined,
}));

mock.module("../../../../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => mockPlatformClientResult,
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
  getSecureKeyViaDaemon: async () => undefined,
  deleteSecureKeyViaDaemon: async () => "not-found" as const,
}));

// Mock shared.js helpers
mock.module("../shared.js", () => ({
  resolveService: (service: string) => {
    const aliases: Record<string, string> = {
      gmail: "integration:google",
      google: "integration:google",
      slack: "integration:slack",
    };
    if (aliases[service]) return aliases[service];
    if (!service.includes(":")) return `integration:${service}`;
    return service;
  },
  isManagedMode: () => false,
  getManagedServiceConfigKey: (key: string) =>
    mockGetManagedServiceConfigKey(key),
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
  fetchActiveConnections: async (
    _client: Record<string, unknown>,
    _provider: string,
    _cmd: Command,
    _options?: { silent?: boolean },
  ): Promise<Array<Record<string, unknown>> | null> => {
    const idx = mockPlatformFetchCallIndex++;
    const result = mockPlatformFetchResults[idx];
    if (!result) return [];
    if (!result.ok) return null;
    return result.body as Array<Record<string, unknown>>;
  },
  toBareProvider: (provider: string): string =>
    provider.startsWith("integration:")
      ? provider.slice("integration:".length)
      : provider,
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks are registered)
// ---------------------------------------------------------------------------

const { registerModeCommand } = await import("../mode.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.option("--json", "JSON output");
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerModeCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant oauth mode", () => {
  beforeEach(() => {
    mockGetProvider = () => undefined;
    mockListActiveConnectionsByProvider = () => [];
    mockGetManagedServiceConfigKey = () => null;
    mockPlatformClientResult = null;
    mockPlatformFetchResults = [];
    mockPlatformFetchCallIndex = 0;
    mockRawConfig = {};
    mockSaveRawConfigCalls = [];
    mockSetNestedValueCalls = [];
    mockConfigServices = {};
    process.exitCode = 0;
  });

  // =========================================================================
  // Get mode
  // =========================================================================

  describe("get mode", () => {
    test("unknown provider returns error", async () => {
      mockGetProvider = () => undefined;

      const { exitCode, stdout } = await runCommand([
        "mode",
        "nonexistent",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Unknown provider");
      expect(parsed.error).toContain("providers list");
    });

    test("provider alias resolution: gmail resolves to integration:google", async () => {
      let capturedProviderKey: string | undefined;

      mockGetProvider = (key: string) => {
        capturedProviderKey = key;
        return {
          providerKey: key,
          managedServiceConfigKey: "google-oauth",
        };
      };
      mockGetManagedServiceConfigKey = () => "google-oauth";
      mockConfigServices = {
        "google-oauth": { mode: "managed" },
      };

      await runCommand(["mode", "gmail", "--json"]);
      expect(capturedProviderKey).toBe("integration:google");
    });

    test("provider without managedServiceConfigKey returns your-own with managedModeSupported: false", async () => {
      mockGetProvider = () => ({
        providerKey: "integration:slack",
        managedServiceConfigKey: null,
      });
      mockGetManagedServiceConfigKey = () => null;

      const { exitCode, stdout } = await runCommand([
        "mode",
        "slack",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.provider).toBe("integration:slack");
      expect(parsed.mode).toBe("your-own");
      expect(parsed.managedModeSupported).toBe(false);
    });

    test("provider in managed mode returns mode: managed with managedModeSupported: true", async () => {
      mockGetProvider = () => ({
        providerKey: "integration:google",
        managedServiceConfigKey: "google-oauth",
      });
      mockGetManagedServiceConfigKey = () => "google-oauth";
      mockConfigServices = {
        "google-oauth": { mode: "managed" },
      };

      const { exitCode, stdout } = await runCommand([
        "mode",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.provider).toBe("integration:google");
      expect(parsed.mode).toBe("managed");
      expect(parsed.managedModeSupported).toBe(true);
    });

    test("provider in your-own mode returns mode: your-own with managedModeSupported: true", async () => {
      mockGetProvider = () => ({
        providerKey: "integration:google",
        managedServiceConfigKey: "google-oauth",
      });
      mockGetManagedServiceConfigKey = () => "google-oauth";
      mockConfigServices = {
        "google-oauth": { mode: "your-own" },
      };

      const { exitCode, stdout } = await runCommand([
        "mode",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.provider).toBe("integration:google");
      expect(parsed.mode).toBe("your-own");
      expect(parsed.managedModeSupported).toBe(true);
    });
  });

  // =========================================================================
  // Set mode
  // =========================================================================

  describe("set mode", () => {
    test("invalid mode value returns error listing valid values", async () => {
      mockGetProvider = () => ({
        providerKey: "integration:google",
        managedServiceConfigKey: "google-oauth",
      });
      mockGetManagedServiceConfigKey = () => "google-oauth";

      const { exitCode, stdout } = await runCommand([
        "mode",
        "google",
        "--set",
        "invalid",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("invalid");
      expect(parsed.error).toContain("managed");
      expect(parsed.error).toContain("your-own");
    });

    test("provider without managedServiceConfigKey returns error about managed mode not available when --set managed", async () => {
      mockGetProvider = () => ({
        providerKey: "integration:slack",
        managedServiceConfigKey: null,
      });
      mockGetManagedServiceConfigKey = () => null;

      const { exitCode, stdout } = await runCommand([
        "mode",
        "slack",
        "--set",
        "managed",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Managed mode is not available");
      expect(parsed.error).toContain("integration:slack");
    });

    test("provider without managedServiceConfigKey treats --set your-own as successful no-op", async () => {
      mockGetProvider = () => ({
        providerKey: "integration:slack",
        managedServiceConfigKey: null,
      });
      mockGetManagedServiceConfigKey = () => null;

      const { exitCode, stdout } = await runCommand([
        "mode",
        "slack",
        "--set",
        "your-own",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.provider).toBe("integration:slack");
      expect(parsed.mode).toBe("your-own");
      expect(parsed.changed).toBe(false);
      expect(parsed.managedModeSupported).toBe(false);
    });

    test("set to same mode returns changed: false", async () => {
      mockGetProvider = () => ({
        providerKey: "integration:google",
        managedServiceConfigKey: "google-oauth",
      });
      mockGetManagedServiceConfigKey = () => "google-oauth";
      mockConfigServices = {
        "google-oauth": { mode: "managed" },
      };

      const { exitCode, stdout } = await runCommand([
        "mode",
        "google",
        "--set",
        "managed",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.provider).toBe("integration:google");
      expect(parsed.mode).toBe("managed");
      expect(parsed.changed).toBe(false);
    });

    test("switch managed -> your-own with active managed connections and no BYO connections includes hint", async () => {
      mockGetProvider = () => ({
        providerKey: "integration:google",
        managedServiceConfigKey: "google-oauth",
      });
      mockGetManagedServiceConfigKey = () => "google-oauth";
      mockConfigServices = {
        "google-oauth": { mode: "managed" },
      };
      mockRawConfig = { services: { "google-oauth": { mode: "managed" } } };

      // Platform has active connections (old mode = managed)
      mockPlatformClientResult = { platformAssistantId: "asst-123" };
      mockPlatformFetchResults = [
        {
          ok: true,
          status: 200,
          body: [{ id: "conn-1", account_label: "user@gmail.com" }],
        },
      ];

      // No BYO connections (new mode = your-own)
      mockListActiveConnectionsByProvider = () => [];

      const { exitCode, stdout } = await runCommand([
        "mode",
        "google",
        "--set",
        "your-own",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.provider).toBe("integration:google");
      expect(parsed.mode).toBe("your-own");
      expect(parsed.changed).toBe(true);
      expect(parsed.hint).toContain("No active connections");
      expect(parsed.hint).toContain("your-own");
      expect(parsed.hint).toContain("connect");
    });

    test("switch your-own -> managed with active BYO connections and no managed connections includes hint", async () => {
      mockGetProvider = () => ({
        providerKey: "integration:google",
        managedServiceConfigKey: "google-oauth",
      });
      mockGetManagedServiceConfigKey = () => "google-oauth";
      mockConfigServices = {
        "google-oauth": { mode: "your-own" },
      };
      mockRawConfig = { services: { "google-oauth": { mode: "your-own" } } };

      // BYO has active connections (old mode = your-own)
      mockListActiveConnectionsByProvider = () => [
        {
          id: "conn-local-1",
          providerKey: "integration:google",
          status: "active",
        },
      ];

      // Platform has no connections (new mode = managed)
      mockPlatformClientResult = { platformAssistantId: "asst-123" };
      mockPlatformFetchResults = [{ ok: true, status: 200, body: [] }];

      const { exitCode, stdout } = await runCommand([
        "mode",
        "google",
        "--set",
        "managed",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.provider).toBe("integration:google");
      expect(parsed.mode).toBe("managed");
      expect(parsed.changed).toBe(true);
      expect(parsed.hint).toContain("No active connections");
      expect(parsed.hint).toContain("managed");
      expect(parsed.hint).toContain("connect");
    });

    test("switch mode with connections on both sides has no hint", async () => {
      mockGetProvider = () => ({
        providerKey: "integration:google",
        managedServiceConfigKey: "google-oauth",
      });
      mockGetManagedServiceConfigKey = () => "google-oauth";
      mockConfigServices = {
        "google-oauth": { mode: "managed" },
      };
      mockRawConfig = { services: { "google-oauth": { mode: "managed" } } };

      // Platform has active connections (old mode = managed)
      mockPlatformClientResult = { platformAssistantId: "asst-123" };
      mockPlatformFetchResults = [
        {
          ok: true,
          status: 200,
          body: [{ id: "conn-1", account_label: "user@gmail.com" }],
        },
      ];

      // BYO also has connections (new mode = your-own)
      mockListActiveConnectionsByProvider = () => [
        {
          id: "conn-local-1",
          providerKey: "integration:google",
          status: "active",
        },
      ];

      const { exitCode, stdout } = await runCommand([
        "mode",
        "google",
        "--set",
        "your-own",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.changed).toBe(true);
      expect(parsed.hint).toBeUndefined();
    });

    test("switch mode with no connections on either side has no hint", async () => {
      mockGetProvider = () => ({
        providerKey: "integration:google",
        managedServiceConfigKey: "google-oauth",
      });
      mockGetManagedServiceConfigKey = () => "google-oauth";
      mockConfigServices = {
        "google-oauth": { mode: "managed" },
      };
      mockRawConfig = { services: { "google-oauth": { mode: "managed" } } };

      // No platform connections
      mockPlatformClientResult = { platformAssistantId: "asst-123" };
      mockPlatformFetchResults = [{ ok: true, status: 200, body: [] }];

      // No BYO connections
      mockListActiveConnectionsByProvider = () => [];

      const { exitCode, stdout } = await runCommand([
        "mode",
        "google",
        "--set",
        "your-own",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.changed).toBe(true);
      expect(parsed.hint).toBeUndefined();
    });

    test("saveRawConfig is called with the correct nested path", async () => {
      mockGetProvider = () => ({
        providerKey: "integration:google",
        managedServiceConfigKey: "google-oauth",
      });
      mockGetManagedServiceConfigKey = () => "google-oauth";
      mockConfigServices = {
        "google-oauth": { mode: "managed" },
      };
      mockRawConfig = { services: { "google-oauth": { mode: "managed" } } };

      // No platform client — skip connection checking
      mockPlatformClientResult = null;
      mockListActiveConnectionsByProvider = () => [];

      await runCommand(["mode", "google", "--set", "your-own", "--json"]);

      // Verify setNestedValue was called with correct path and value
      expect(mockSetNestedValueCalls.length).toBeGreaterThanOrEqual(1);
      const setCall = mockSetNestedValueCalls[0];
      expect(setCall.path).toBe("services.google-oauth.mode");
      expect(setCall.value).toBe("your-own");

      // Verify saveRawConfig was called
      expect(mockSaveRawConfigCalls.length).toBe(1);
    });
  });
});
