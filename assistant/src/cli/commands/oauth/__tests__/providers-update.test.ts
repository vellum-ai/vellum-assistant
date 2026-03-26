import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockGetProvider: (
  key: string,
) => Record<string, unknown> | undefined = () => undefined;

let mockUpdateProvider: (
  key: string,
  params: Record<string, unknown>,
) => Record<string, unknown> | undefined = () => undefined;

let mockUpdateProviderCalls: Array<{
  key: string;
  params: Record<string, unknown>;
}> = [];

let mockSeededProviderKeys = new Set<string>(["google", "slack", "github"]);

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
  updateProvider: (key: string, params: Record<string, unknown>) => {
    mockUpdateProviderCalls.push({ key, params });
    return mockUpdateProvider(key, params);
  },
  listProviders: () => [],
  registerProvider: () => ({}),
  seedProviders: () => {},
  getConnection: () => undefined,
  getConnectionByProvider: () => undefined,
  getActiveConnection: () => undefined,
  listActiveConnectionsByProvider: () => [],
  isProviderConnected: () => false,
  createConnection: () => ({}),
  updateConnection: () => ({}),
  deleteConnection: () => false,
  upsertApp: async () => ({}),
  getApp: () => undefined,
  getAppByProviderAndClientId: () => undefined,
  getMostRecentAppByProvider: () => undefined,
  listApps: () => [],
  deleteApp: async () => false,
  listConnections: () => [],
}));

mock.module("../../../../oauth/seed-providers.js", () => ({
  SEEDED_PROVIDER_KEYS: mockSeededProviderKeys,
  PROVIDER_SEED_DATA: {},
  seedAllProviders: () => {},
}));

mock.module("../../../../oauth/provider-behaviors.js", () => ({
  getProviderBehavior: () => undefined,
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
    info: () => {},
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
// Sample provider row
// ---------------------------------------------------------------------------

const sampleProviderRow = {
  providerKey: "custom-api",
  authUrl: "https://custom-api.example.com/oauth/authorize",
  tokenUrl: "https://custom-api.example.com/oauth/token",
  tokenEndpointAuthMethod: null,
  userinfoUrl: null,
  baseUrl: null,
  defaultScopes: "[]",
  scopePolicy: "{}",
  extraParams: null,
  callbackTransport: null,
  managedServiceConfigKey: null,
  pingUrl: null,
  pingMethod: null,
  pingHeaders: null,
  pingBody: null,
  displayName: null,
  description: null,
  dashboardUrl: null,
  clientIdPlaceholder: null,
  requiresClientSecret: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant oauth providers update", () => {
  beforeEach(() => {
    mockGetProvider = () => undefined;
    mockUpdateProvider = () => undefined;
    mockUpdateProviderCalls = [];
    mockSeededProviderKeys = new Set(["google", "slack", "github"]);
    process.exitCode = 0;
  });

  // -------------------------------------------------------------------------
  // Provider not found
  // -------------------------------------------------------------------------

  test("provider not found returns error with hint", async () => {
    mockGetProvider = () => undefined;

    const { exitCode, stdout } = await runCommand([
      "providers",
      "update",
      "nonexistent",
      "--display-name",
      "Foo",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("not found");
    expect(parsed.error).toContain("providers list");
  });

  // -------------------------------------------------------------------------
  // Built-in provider
  // -------------------------------------------------------------------------

  test("built-in provider returns error suggesting register", async () => {
    mockGetProvider = () => ({
      ...sampleProviderRow,
      providerKey: "google",
    });

    const { exitCode, stdout } = await runCommand([
      "providers",
      "update",
      "google",
      "--display-name",
      "Foo",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Cannot update built-in");
    expect(parsed.error).toContain("providers register");
  });

  // -------------------------------------------------------------------------
  // No options provided
  // -------------------------------------------------------------------------

  test("no options provided returns error", async () => {
    mockGetProvider = () => ({ ...sampleProviderRow });

    const { exitCode, stdout } = await runCommand([
      "providers",
      "update",
      "custom-api",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Nothing to update");
  });

  // -------------------------------------------------------------------------
  // Successful update with --display-name
  // -------------------------------------------------------------------------

  test("successful update with --display-name returns updated provider row", async () => {
    mockGetProvider = () => ({ ...sampleProviderRow });
    mockUpdateProvider = (_key, _params) => ({
      ...sampleProviderRow,
      displayName: "New Name",
      updatedAt: Date.now(),
    });

    const { exitCode, stdout } = await runCommand([
      "providers",
      "update",
      "custom-api",
      "--display-name",
      "New Name",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.providerKey).toBe("custom-api");
    expect(parsed.displayName).toBe("New Name");
  });

  // -------------------------------------------------------------------------
  // Successful update with multiple options
  // -------------------------------------------------------------------------

  test("successful update with multiple options passes all fields to updateProvider", async () => {
    mockGetProvider = () => ({ ...sampleProviderRow });
    mockUpdateProvider = (_key, _params) => ({
      ...sampleProviderRow,
      displayName: "My API",
      defaultScopes: '["read","write"]',
      authUrl: "https://new.example.com/auth",
      updatedAt: Date.now(),
    });

    const { exitCode, stdout } = await runCommand([
      "providers",
      "update",
      "custom-api",
      "--display-name",
      "My API",
      "--scopes",
      "read,write",
      "--auth-url",
      "https://new.example.com/auth",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.providerKey).toBe("custom-api");

    // Verify updateProvider was called with the correct params
    expect(mockUpdateProviderCalls).toHaveLength(1);
    expect(mockUpdateProviderCalls[0].key).toBe("custom-api");
    expect(mockUpdateProviderCalls[0].params).toEqual({
      displayName: "My API",
      defaultScopes: ["read", "write"],
      authUrl: "https://new.example.com/auth",
    });
  });
});
