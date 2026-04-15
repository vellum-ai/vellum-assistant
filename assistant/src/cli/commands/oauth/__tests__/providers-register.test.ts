import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockRegisterProvider: (
  params: Record<string, unknown>,
) => Record<string, unknown> = () => ({});

let mockRegisterProviderCalls: Array<{
  params: Record<string, unknown>;
}> = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => ({ services: {} }),
  loadConfig: () => ({ services: {} }),
  API_KEY_PROVIDERS: [],
}));

mock.module("../../../../oauth/oauth-store.js", () => ({
  getProvider: () => undefined,
  updateProvider: () => undefined,
  listProviders: () => [],
  registerProvider: (params: Record<string, unknown>) => {
    mockRegisterProviderCalls.push({ params });
    return mockRegisterProvider(params);
  },
  deleteProvider: () => false,
  disconnectOAuthProvider: async () => "ok",
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
  SEEDED_PROVIDER_KEYS: new Set<string>(["google", "slack", "github"]),
  PROVIDER_SEED_DATA: {},
  seedAllProviders: () => {},
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
      writeErr: (str: string) => stderrChunks.push(str),
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

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

// ---------------------------------------------------------------------------
// Sample provider row
// ---------------------------------------------------------------------------

const sampleProviderRow = {
  provider: "custom-api",
  authorizeUrl: "https://custom-api.example.com/oauth/authorize",
  tokenExchangeUrl: "https://custom-api.example.com/oauth/token",
  refreshUrl: null,
  tokenEndpointAuthMethod: "client_secret_post",
  tokenExchangeBodyFormat: "form",
  userinfoUrl: null,
  baseUrl: null,
  defaultScopes: "[]",
  scopePolicy: "{}",
  scopeSeparator: null,
  authorizeParams: null,
  managedServiceConfigKey: null,
  pingUrl: null,
  pingMethod: null,
  pingHeaders: null,
  pingBody: null,
  revokeUrl: null,
  revokeBodyTemplate: null,
  displayLabel: null,
  description: null,
  dashboardUrl: null,
  logoUrl: null,
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
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant oauth providers register", () => {
  beforeEach(() => {
    mockRegisterProvider = () => ({ ...sampleProviderRow });
    mockRegisterProviderCalls = [];
    process.exitCode = 0;
  });

  // -------------------------------------------------------------------------
  // --logo-url
  // -------------------------------------------------------------------------

  test("register accepts --logo-url and passes it to registerProvider", async () => {
    mockRegisterProvider = () => ({
      ...sampleProviderRow,
      logoUrl: "https://example.com/logo.png",
    });

    const { exitCode } = await runCommand([
      "providers",
      "register",
      "--provider-key",
      "custom-api",
      "--auth-url",
      "https://custom-api.example.com/oauth/authorize",
      "--token-url",
      "https://custom-api.example.com/oauth/token",
      "--logo-url",
      "https://example.com/logo.png",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(mockRegisterProviderCalls).toHaveLength(1);
    expect(mockRegisterProviderCalls[0].params.logoUrl).toBe(
      "https://example.com/logo.png",
    );
  });

  // -------------------------------------------------------------------------
  // --logo-simpleicons-slug
  // -------------------------------------------------------------------------

  test("register accepts --logo-simpleicons-slug and expands it to the CDN URL", async () => {
    mockRegisterProvider = () => ({
      ...sampleProviderRow,
      logoUrl: "https://cdn.simpleicons.org/notion",
    });

    const { exitCode } = await runCommand([
      "providers",
      "register",
      "--provider-key",
      "custom-api",
      "--auth-url",
      "https://custom-api.example.com/oauth/authorize",
      "--token-url",
      "https://custom-api.example.com/oauth/token",
      "--logo-simpleicons-slug",
      "notion",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(mockRegisterProviderCalls).toHaveLength(1);
    expect(mockRegisterProviderCalls[0].params.logoUrl).toBe(
      "https://cdn.simpleicons.org/notion",
    );
  });

  // -------------------------------------------------------------------------
  // Mutual exclusion
  // -------------------------------------------------------------------------

  test("register rejects both --logo-url and --logo-simpleicons-slug simultaneously", async () => {
    const { exitCode, stdout } = await runCommand([
      "providers",
      "register",
      "--provider-key",
      "custom-api",
      "--auth-url",
      "https://custom-api.example.com/oauth/authorize",
      "--token-url",
      "https://custom-api.example.com/oauth/token",
      "--logo-url",
      "https://example.com/logo.png",
      "--logo-simpleicons-slug",
      "notion",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("mutually exclusive");
    expect(mockRegisterProviderCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Empty slug rejection
  // -------------------------------------------------------------------------

  test("register rejects empty --logo-simpleicons-slug", async () => {
    const { exitCode, stdout } = await runCommand([
      "providers",
      "register",
      "--provider-key",
      "custom-api",
      "--auth-url",
      "https://custom-api.example.com/oauth/authorize",
      "--token-url",
      "https://custom-api.example.com/oauth/token",
      "--logo-simpleicons-slug",
      "",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("cannot be empty");
    expect(mockRegisterProviderCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Empty --logo-url rejection at registration time
  // -------------------------------------------------------------------------

  test("register rejects empty --logo-url (clearing is only valid at update time)", async () => {
    const { exitCode, stdout } = await runCommand([
      "providers",
      "register",
      "--provider-key",
      "custom-api",
      "--auth-url",
      "https://custom-api.example.com/oauth/authorize",
      "--token-url",
      "https://custom-api.example.com/oauth/token",
      "--logo-url",
      "",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Cannot clear logo_url");
    expect(mockRegisterProviderCalls).toHaveLength(0);
  });
});
