import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockPlatformClientCreate: () => Promise<Record<
  string,
  unknown
> | null> = async () => null;

let mockLoadRawConfig: () => Record<string, unknown> = () => ({});
const mockSaveRawConfigCalls: Array<Record<string, unknown>> = [];
const mockSetNestedValueCalls: Array<{
  obj: Record<string, unknown>;
  key: string;
  value: unknown;
}> = [];
let mockGetNestedValue: (
  obj: Record<string, unknown>,
  key: string,
) => unknown = () => undefined;

// ---------------------------------------------------------------------------
// Mocks — platform/client (controls requirePlatformConnection)
// ---------------------------------------------------------------------------

mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: () => mockPlatformClientCreate(),
  },
}));

// ---------------------------------------------------------------------------
// Mocks — config/loader
// ---------------------------------------------------------------------------

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ services: {} }),
  loadConfig: () => ({ services: {} }),
  invalidateConfigCache: () => {},
  loadRawConfig: () => mockLoadRawConfig(),
  saveRawConfig: (raw: Record<string, unknown>) => {
    mockSaveRawConfigCalls.push(raw);
  },
  applyNestedDefaults: (c: unknown) => c,
  deepMergeOverwrite: (a: unknown) => a,
  mergeDefaultWorkspaceConfig: () => {},
  getNestedValue: (obj: Record<string, unknown>, key: string) =>
    mockGetNestedValue(obj, key),
  setNestedValue: (
    obj: Record<string, unknown>,
    key: string,
    value: unknown,
  ) => {
    mockSetNestedValueCalls.push({ obj, key, value });
    const keys = key.split(".");
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const segment = keys[i]!;
      if (
        current[segment] == null ||
        typeof current[segment] !== "object" ||
        Array.isArray(current[segment])
      ) {
        current[segment] = {};
      }
      current = current[segment] as Record<string, unknown>;
    }
    current[keys[keys.length - 1]!] = value;
  },
  API_KEY_PROVIDERS: [
    "anthropic",
    "openai",
    "gemini",
    "ollama",
    "fireworks",
    "openrouter",
    "brave",
    "perplexity",
  ],
}));

// ---------------------------------------------------------------------------
// Mocks — util/logger (suppress log output)
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
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

// ---------------------------------------------------------------------------
// Mocks — oauth/oauth-store (transitive dep of oauth/shared.ts)
// ---------------------------------------------------------------------------

mock.module("../oauth/oauth-store.js", () => ({
  disconnectOAuthProvider: async () => "not-found" as const,
  getConnection: () => undefined,
  getConnectionByProvider: () => undefined,
  listConnections: () => [],
  deleteConnection: () => false,
  upsertApp: async () => ({}),
  getApp: () => undefined,
  getAppByProviderAndClientId: () => undefined,
  getMostRecentAppByProvider: () => undefined,
  listApps: () => [],
  deleteApp: async () => false,
  getProvider: () => undefined,
  listProviders: () => [],
  registerProvider: () => ({}),
  updateProvider: () => undefined,
  deleteProvider: () => false,
  seedProviders: () => {},
  getActiveConnection: () => undefined,
  listActiveConnectionsByProvider: () => [],
  createConnection: () => ({}),
  isProviderConnected: () => false,
  updateConnection: () => ({}),
}));

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are registered)
// ---------------------------------------------------------------------------

const { registerConfigCommand } = await import("../cli/commands/config.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string }> {
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
    program.option("--json", "JSON output");
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerConfigCommand(program);
    await program.parseAsync(args);
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
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("config set — platform connection guard for service mode paths", () => {
  beforeEach(() => {
    // Default: not connected to platform
    mockPlatformClientCreate = async () => null;
    mockLoadRawConfig = () => ({});
    mockSaveRawConfigCalls.length = 0;
    mockSetNestedValueCalls.length = 0;
    mockGetNestedValue = () => undefined;
  });

  test("config set services.inference.mode managed — fails when not connected", async () => {
    const { exitCode, stdout } = await runCli([
      "node",
      "assistant",
      "--json",
      "config",
      "set",
      "services.inference.mode",
      "managed",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("vellum platform connect");
    expect(parsed.error).toContain("Not connected");
    // Config should NOT have been written
    expect(mockSaveRawConfigCalls).toHaveLength(0);
    expect(mockSetNestedValueCalls).toHaveLength(0);
  });

  test("config set services.image-generation.mode your-own — succeeds without platform connection", async () => {
    const { exitCode } = await runCli([
      "node",
      "assistant",
      "--json",
      "config",
      "set",
      "services.image-generation.mode",
      "your-own",
    ]);

    expect(exitCode).toBe(0);
    // Config should have been written — setting to "your-own" doesn't need platform
    expect(mockSetNestedValueCalls).toHaveLength(1);
    expect(mockSetNestedValueCalls[0]!.key).toBe(
      "services.image-generation.mode",
    );
    expect(mockSetNestedValueCalls[0]!.value).toBe("your-own");
    expect(mockSaveRawConfigCalls).toHaveLength(1);
  });

  test("config set calls.enabled true — succeeds without platform connection", async () => {
    const { exitCode } = await runCli([
      "node",
      "assistant",
      "config",
      "set",
      "calls.enabled",
      "true",
    ]);

    expect(exitCode).toBe(0);
    // Config should have been written
    expect(mockSetNestedValueCalls).toHaveLength(1);
    expect(mockSetNestedValueCalls[0]!.key).toBe("calls.enabled");
    expect(mockSetNestedValueCalls[0]!.value).toBe(true);
    expect(mockSaveRawConfigCalls).toHaveLength(1);
  });

  test("config set ingress.publicBaseUrl overwrites existing value", async () => {
    mockLoadRawConfig = () => ({
      ingress: {
        publicBaseUrl: "https://stale-velay.example.test",
        publicBaseUrlManagedBy: "velay",
      },
    });

    const { exitCode } = await runCli([
      "node",
      "assistant",
      "config",
      "set",
      "ingress.publicBaseUrl",
      "https://manual.example.test",
    ]);

    expect(exitCode).toBe(0);
    expect(mockSaveRawConfigCalls).toHaveLength(1);
    expect(mockSaveRawConfigCalls[0]).toEqual({
      ingress: {
        publicBaseUrl: "https://manual.example.test",
        publicBaseUrlManagedBy: "velay",
      },
    });
  });

  test("config get services.inference.mode — works without platform connection", async () => {
    mockGetNestedValue = (_obj, key) => {
      if (key === "services.inference.mode") return "your-own";
      return undefined;
    };

    const { exitCode } = await runCli([
      "node",
      "assistant",
      "config",
      "get",
      "services.inference.mode",
    ]);

    expect(exitCode).toBe(0);
    // No writes should have occurred
    expect(mockSaveRawConfigCalls).toHaveLength(0);
    expect(mockSetNestedValueCalls).toHaveLength(0);
  });

  test("config set services.web-search.mode managed — fails when not connected", async () => {
    const { exitCode, stdout } = await runCli([
      "node",
      "assistant",
      "--json",
      "config",
      "set",
      "services.web-search.mode",
      "managed",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("vellum platform connect");
    expect(mockSaveRawConfigCalls).toHaveLength(0);
  });

  test("config set services.inference.mode managed — succeeds when connected", async () => {
    mockPlatformClientCreate = async () => ({
      platformAssistantId: "asst-123",
      fetch: async () => new Response(),
    });

    const { exitCode } = await runCli([
      "node",
      "assistant",
      "config",
      "set",
      "services.inference.mode",
      "managed",
    ]);

    expect(exitCode).toBe(0);
    expect(mockSetNestedValueCalls).toHaveLength(1);
    expect(mockSetNestedValueCalls[0]!.key).toBe("services.inference.mode");
    expect(mockSetNestedValueCalls[0]!.value).toBe("managed");
    expect(mockSaveRawConfigCalls).toHaveLength(1);
  });
});
