import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockWithValidToken: <T>(
  service: string,
  cb: (token: string) => Promise<T>,
) => Promise<T>;

let mockListProviders: () => Array<Record<string, unknown>> = () => [];
const secureKeyStore = new Map<string, string>();
const metadataStore: Array<{
  credentialId: string;
  service: string;
  field: string;
  allowedTools: string[];
  allowedDomains: string[];
  createdAt: number;
  updatedAt: number;
}> = [];
const disconnectOAuthProviderCalls: string[] = [];
const disconnectOAuthProviderResult: "disconnected" | "not-found" | "error" =
  "not-found";

// In-memory provider store used by registerProvider/updateProvider/getProvider
// mocks below. Tests that exercise the providers register/update/get commands
// can read and write through this map directly.
const mockProviderStore = new Map<string, Record<string, unknown>>();

// App upsert mock state
let mockUpsertAppCalls: Array<{
  provider: string;
  clientId: string;
  clientSecretOpts?: {
    clientSecretValue?: string;
    clientSecretCredentialPath?: string;
  };
}> = [];
let mockUpsertAppResult: Record<string, unknown> = {
  id: "app-upsert-1",
  provider: "test",
  clientId: "test-client-id",
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};
let mockUpsertAppImpl:
  | ((
      provider: string,
      clientId: string,
      clientSecretOpts?: {
        clientSecretValue?: string;
        clientSecretCredentialPath?: string;
      },
    ) => Promise<Record<string, unknown>>)
  | undefined;

// Transitive mock state (connect-orchestrator, etc.)
let mockOrchestrateOAuthConnect: (
  opts: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
let mockGetAppByProviderAndClientId: (
  provider: string,
  clientId: string,
) => Record<string, unknown> | undefined = () => undefined;
let mockGetMostRecentAppByProvider: (
  provider: string,
) => Record<string, unknown> | undefined = () => undefined;
let mockGetProvider: (
  provider: string,
) => Record<string, unknown> | undefined = () => undefined;
let mockGetSecureKey: (account: string) => string | undefined = () => undefined;
let mockResolveOAuthConnection: (
  provider: string,
  options?: Record<string, unknown>,
) => Promise<{
  request: (req: Record<string, unknown>) => Promise<{
    status: number;
    headers: Record<string, string>;
    body: unknown;
  }>;
  withToken: <T>(fn: (token: string) => Promise<T>) => Promise<T>;
  id: string;
  provider: string;
  accountInfo: string | null;
}> = async () => {
  throw new Error("resolveOAuthConnection not configured in test");
};
let mockGetCredentialMetadata: (
  service: string,
  field: string,
) => Record<string, unknown> | undefined = () => undefined;
let mockPlatformClientCreate: () => Promise<Record<
  string,
  unknown
> | null> = async () => null;

// ---------------------------------------------------------------------------
// Mock token-manager
// ---------------------------------------------------------------------------

mock.module("../security/token-manager.js", () => ({
  withValidToken: <T>(
    service: string,
    cb: (token: string) => Promise<T>,
  ): Promise<T> => mockWithValidToken(service, cb),
  // Stubs for any transitive imports that reference other exports:
  TokenExpiredError: class TokenExpiredError extends Error {
    constructor(
      public readonly service: string,
      message?: string,
    ) {
      super(message ?? `Token expired for "${service}".`);
      this.name = "TokenExpiredError";
    }
  },
}));

// ---------------------------------------------------------------------------
// Mock oauth-store
// ---------------------------------------------------------------------------

mock.module("../oauth/oauth-store.js", () => ({
  disconnectOAuthProvider: async (
    provider: string,
  ): Promise<"disconnected" | "not-found" | "error"> => {
    disconnectOAuthProviderCalls.push(provider);
    return disconnectOAuthProviderResult;
  },
  getConnection: () => undefined,
  getConnectionByProvider: () => undefined,
  listConnections: () => [],
  deleteConnection: () => false,
  // Stubs required by apps.ts and providers.ts (transitively loaded via oauth/index.ts)
  upsertApp: async (
    provider: string,
    clientId: string,
    clientSecretOpts?: {
      clientSecretValue?: string;
      clientSecretCredentialPath?: string;
    },
  ) => {
    if (mockUpsertAppImpl) {
      return mockUpsertAppImpl(provider, clientId, clientSecretOpts);
    }
    mockUpsertAppCalls.push({ provider, clientId, clientSecretOpts });
    return mockUpsertAppResult;
  },
  getApp: () => undefined,
  getAppByProviderAndClientId: (provider: string, clientId: string) =>
    mockGetAppByProviderAndClientId(provider, clientId),
  getMostRecentAppByProvider: (provider: string) =>
    mockGetMostRecentAppByProvider(provider),
  listApps: () => [],
  deleteApp: async () => false,
  getProvider: (provider: string) => {
    // If the test has plugged in a custom mockGetProvider, prefer that.
    const custom = mockGetProvider(provider);
    if (custom !== undefined) return custom;
    return mockProviderStore.get(provider);
  },
  listProviders: () => mockListProviders(),
  registerProvider: (params: Record<string, unknown>) => {
    const now = Date.now();
    const row: Record<string, unknown> = {
      provider: params.provider,
      authorizeUrl: params.authorizeUrl,
      tokenExchangeUrl: params.tokenExchangeUrl,
      refreshUrl: (params.refreshUrl as string | undefined) ?? null,
      tokenEndpointAuthMethod: params.tokenEndpointAuthMethod ?? null,
      userinfoUrl: params.userinfoUrl ?? null,
      baseUrl: params.baseUrl ?? null,
      defaultScopes: JSON.stringify(params.defaultScopes ?? []),
      scopePolicy: JSON.stringify(params.scopePolicy ?? {}),
      scopeSeparator: (params.scopeSeparator as string | undefined) ?? " ",
      authorizeParams: params.authorizeParams
        ? JSON.stringify(params.authorizeParams)
        : null,
      pingUrl: params.pingUrl ?? null,
      pingMethod: params.pingMethod ?? null,
      pingHeaders: params.pingHeaders
        ? JSON.stringify(params.pingHeaders)
        : null,
      pingBody:
        params.pingBody !== undefined ? JSON.stringify(params.pingBody) : null,
      managedServiceConfigKey: params.managedServiceConfigKey ?? null,
      displayLabel: params.displayLabel ?? null,
      description: params.description ?? null,
      dashboardUrl: params.dashboardUrl ?? null,
      clientIdPlaceholder: params.clientIdPlaceholder ?? null,
      requiresClientSecret: params.requiresClientSecret ?? 1,
      loopbackPort: params.loopbackPort ?? null,
      injectionTemplates: params.injectionTemplates
        ? JSON.stringify(params.injectionTemplates)
        : null,
      appType: params.appType ?? null,
      setupNotes: params.setupNotes ? JSON.stringify(params.setupNotes) : null,
      identityUrl: params.identityUrl ?? null,
      identityMethod: params.identityMethod ?? null,
      identityHeaders: params.identityHeaders
        ? JSON.stringify(params.identityHeaders)
        : null,
      identityBody:
        params.identityBody !== undefined
          ? JSON.stringify(params.identityBody)
          : null,
      identityResponsePaths: params.identityResponsePaths
        ? JSON.stringify(params.identityResponsePaths)
        : null,
      identityFormat: params.identityFormat ?? null,
      identityOkField: params.identityOkField ?? null,
      featureFlag: params.featureFlag ?? null,
      createdAt: now,
      updatedAt: now,
    };
    mockProviderStore.set(params.provider as string, row);
    return row;
  },
  updateProvider: (provider: string, params: Record<string, unknown>) => {
    const existing = mockProviderStore.get(provider);
    if (!existing) return undefined;
    const updated: Record<string, unknown> = { ...existing };
    if (params.scopeSeparator !== undefined) {
      updated.scopeSeparator = params.scopeSeparator;
    }
    if (params.authorizeUrl !== undefined) {
      updated.authorizeUrl = params.authorizeUrl;
    }
    if (params.tokenExchangeUrl !== undefined) {
      updated.tokenExchangeUrl = params.tokenExchangeUrl;
    }
    if (params.refreshUrl !== undefined) {
      updated.refreshUrl = params.refreshUrl;
    }
    if (params.defaultScopes !== undefined) {
      updated.defaultScopes = JSON.stringify(params.defaultScopes);
    }
    if (params.displayLabel !== undefined) {
      updated.displayLabel = params.displayLabel;
    }
    updated.updatedAt = Date.now();
    mockProviderStore.set(provider, updated);
    return updated;
  },
  deleteProvider: () => false,
  seedProviders: () => {},
  getActiveConnection: () => undefined,
  listActiveConnectionsByProvider: () => [],
  createConnection: () => ({}),
  isProviderConnected: () => false,
  updateConnection: () => ({}),
}));

// Stub out transitive dependencies that token-manager would normally pull in
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (account: string) => mockGetSecureKey(account),
  getSecureKeyResultAsync: async (account: string) => ({
    value: mockGetSecureKey(account),
    unreachable: false,
  }),
  setSecureKeyAsync: async () => true,
  deleteSecureKeyAsync: async (account: string) => {
    if (secureKeyStore.has(account)) {
      secureKeyStore.delete(account);
      return "deleted" as const;
    }
    return "not-found" as const;
  },
  listSecureKeysAsync: async () => ({
    accounts: [...secureKeyStore.keys()],
    unreachable: false,
  }),
  _resetBackend: () => {},
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  assertMetadataWritable: () => {},
  getCredentialMetadata: (service: string, field: string) =>
    mockGetCredentialMetadata(service, field),
  upsertCredentialMetadata: () => ({}),
  listCredentialMetadata: () => [],
  deleteCredentialMetadata: (service: string, field: string): boolean => {
    const idx = metadataStore.findIndex(
      (c) => c.service === service && c.field === field,
    );
    if (idx === -1) return false;
    metadataStore.splice(idx, 1);
    return true;
  },
}));

// ---------------------------------------------------------------------------
// Mock connect-orchestrator
// ---------------------------------------------------------------------------

mock.module("../oauth/connect-orchestrator.js", () => ({
  orchestrateOAuthConnect: (opts: Record<string, unknown>) =>
    mockOrchestrateOAuthConnect(opts),
}));

mock.module("../oauth/seed-providers.js", () => ({
  SEEDED_PROVIDER_KEYS: new Set([
    "google",
    "slack",
    "github",
    "notion",
    "twitter",
    "linear",
  ]),
  seedOAuthProviders: () => {},
}));

// ---------------------------------------------------------------------------
// Mock connection-resolver (needed by request.ts)
// ---------------------------------------------------------------------------

mock.module("../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: (
    provider: string,
    options?: Record<string, unknown>,
  ) => mockResolveOAuthConnection(provider, options),
}));

// ---------------------------------------------------------------------------
// Mock platform/client (needed by request.ts)
// ---------------------------------------------------------------------------

mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: () => mockPlatformClientCreate(),
  },
}));

// ---------------------------------------------------------------------------
// Mock config/loader (needed by isManagedMode in shared.ts)
// ---------------------------------------------------------------------------

let mockGetConfig: () => Record<string, unknown> = () => ({
  services: {},
});

mock.module("../config/loader.js", () => ({
  getConfig: () => mockGetConfig(),
  loadConfig: () => mockGetConfig(),
  saveConfig: () => {},
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  applyNestedDefaults: (c: unknown) => c,
  deepMergeMissing: (a: unknown) => a,
  deepMergeOverwrite: (a: unknown) => a,
  mergeDefaultWorkspaceConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
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
// Import the module under test (after mocks are registered)
// ---------------------------------------------------------------------------

const { registerOAuthCommand } = await import("../cli/commands/oauth/index.js");
const { requirePlatformClient, requirePlatformConnection } =
  await import("../cli/commands/oauth/shared.js");

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
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerOAuthCommand(program);
    await program.parseAsync(["node", "assistant", "oauth", ...args]);
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

describe("assistant oauth token <provider-key>", () => {
  beforeEach(() => {
    mockWithValidToken = async (_service, cb) => cb("mock-access-token-xyz");
  });

  test("prints bare token in human mode", async () => {
    const { exitCode, stdout } = await runCli(["token", "twitter"]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("mock-access-token-xyz\n");
  });

  test("prints JSON in --json mode", async () => {
    const { exitCode, stdout } = await runCli(["token", "twitter", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: true, token: "mock-access-token-xyz" });
  });

  test("passes provider key directly to withValidToken", async () => {
    let capturedService: string | undefined;
    mockWithValidToken = async (service, cb) => {
      capturedService = service;
      return cb("tok");
    };

    await runCli(["token", "twitter"]);
    expect(capturedService).toBe("twitter");
  });

  test("works with other provider keys", async () => {
    let capturedService: string | undefined;
    mockWithValidToken = async (service, cb) => {
      capturedService = service;
      return cb("gmail-token");
    };

    const { exitCode, stdout } = await runCli(["token", "google"]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("gmail-token\n");
    expect(capturedService).toBe("google");
  });

  test("exits 1 when no token exists", async () => {
    mockWithValidToken = async () => {
      throw new Error(
        'No access token found for "twitter". Authorization required.',
      );
    };

    const { exitCode, stdout } = await runCli(["token", "twitter", "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No access token found");
  });

  test("exits 1 when refresh fails", async () => {
    mockWithValidToken = async () => {
      throw new Error('Token refresh failed for "twitter": invalid_grant.');
    };

    const { exitCode, stdout } = await runCli(["token", "twitter", "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Token refresh failed");
  });

  test("returns refreshed token transparently", async () => {
    // Simulate withValidToken refreshing and returning a new token
    mockWithValidToken = async (_service, cb) => cb("refreshed-new-token");

    const { exitCode, stdout } = await runCli(["token", "twitter"]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("refreshed-new-token\n");
  });

  test("missing provider-key argument exits non-zero", async () => {
    const { exitCode } = await runCli(["token"]);
    expect(exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// providers list
// ---------------------------------------------------------------------------

describe("assistant oauth providers list", () => {
  const fakeProviders = [
    {
      provider: "google",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenExchangeUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: "[]",
      scopePolicy: "{}",
      authorizeParams: null,
      managedServiceConfigKey: "google-oauth",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
    {
      provider: "google-calendar",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenExchangeUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: "[]",
      scopePolicy: "{}",
      authorizeParams: null,
      managedServiceConfigKey: "google-calendar-oauth",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
    {
      provider: "slack",
      authorizeUrl: "https://slack.com/oauth/v2/authorize",
      tokenExchangeUrl: "https://slack.com/api/oauth.v2.access",
      defaultScopes: "[]",
      scopePolicy: "{}",
      authorizeParams: null,
      managedServiceConfigKey: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
    {
      provider: "twitter",
      authorizeUrl: "https://twitter.com/i/oauth2/authorize",
      tokenExchangeUrl: "https://api.twitter.com/2/oauth2/token",
      defaultScopes: "[]",
      scopePolicy: "{}",
      authorizeParams: null,
      managedServiceConfigKey: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
  ];

  beforeEach(() => {
    mockWithValidToken = async (_service, cb) => cb("mock-access-token-xyz");
    mockListProviders = () => fakeProviders;
  });

  test("returns all providers when no --provider-key is given", async () => {
    const { exitCode, stdout } = await runCli(["providers", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveLength(4);
    const keys = parsed.map((p: { providerKey: string }) => p.providerKey);
    expect(keys).toContain("google");
    expect(keys).toContain("google-calendar");
    expect(keys).toContain("slack");
    expect(keys).toContain("twitter");
  });

  test("filters by single --provider-key value", async () => {
    const { exitCode, stdout } = await runCli([
      "providers",
      "list",
      "--provider-key",
      "slack",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].providerKey).toBe("slack");
  });

  test("filters by comma-separated OR values", async () => {
    const { exitCode, stdout } = await runCli([
      "providers",
      "list",
      "--provider-key",
      "slack,google",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveLength(3);
    const keys = parsed.map((p: { providerKey: string }) => p.providerKey);
    expect(keys).toContain("google");
    expect(keys).toContain("google-calendar");
    expect(keys).toContain("slack");
  });

  test("returns empty array when comma-separated filter has no matches", async () => {
    const { exitCode, stdout } = await runCli([
      "providers",
      "list",
      "--provider-key",
      "notion,linear",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveLength(0);
  });

  test("trims whitespace around commas in --provider-key", async () => {
    const { exitCode, stdout } = await runCli([
      "providers",
      "list",
      "--provider-key",
      "slack, google",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveLength(3);
    const keys = parsed.map((p: { providerKey: string }) => p.providerKey);
    expect(keys).toContain("google");
    expect(keys).toContain("google-calendar");
    expect(keys).toContain("slack");
  });

  test("ignores empty segments from extra commas in --provider-key", async () => {
    const { exitCode, stdout } = await runCli([
      "providers",
      "list",
      "--provider-key",
      "slack,,google",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveLength(3);
    const keys = parsed.map((p: { providerKey: string }) => p.providerKey);
    expect(keys).toContain("google");
    expect(keys).toContain("google-calendar");
    expect(keys).toContain("slack");
  });

  test("--supports-managed returns only providers with managedServiceConfigKey set", async () => {
    const { exitCode, stdout } = await runCli([
      "providers",
      "list",
      "--supports-managed",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveLength(2);
    const keys = parsed.map((p: { providerKey: string }) => p.providerKey);
    expect(keys).toContain("google");
    expect(keys).toContain("google-calendar");
    expect(keys).not.toContain("slack");
    expect(keys).not.toContain("twitter");
  });

  test("--supports-managed combined with --provider-key applies both filters (AND)", async () => {
    const { exitCode, stdout } = await runCli([
      "providers",
      "list",
      "--supports-managed",
      "--provider-key",
      "google",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    // Both google and google-calendar match --provider-key "google" AND have
    // managedServiceConfigKey set, so both are returned.
    expect(parsed).toHaveLength(2);
    const keys = parsed.map((p: { providerKey: string }) => p.providerKey);
    expect(keys).toContain("google");
    expect(keys).toContain("google-calendar");
  });

  test("without --supports-managed all providers are returned (existing behavior)", async () => {
    const { exitCode, stdout } = await runCli(["providers", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveLength(4);
    const keys = parsed.map((p: { providerKey: string }) => p.providerKey);
    expect(keys).toContain("google");
    expect(keys).toContain("google-calendar");
    expect(keys).toContain("slack");
    expect(keys).toContain("twitter");
  });
});

// ---------------------------------------------------------------------------
// apps upsert --client-secret-credential-path
// ---------------------------------------------------------------------------

describe("assistant oauth apps upsert --client-secret-credential-path", () => {
  beforeEach(() => {
    mockWithValidToken = async (_service, cb) => cb("mock-access-token-xyz");
    mockUpsertAppCalls = [];
    mockUpsertAppResult = {
      id: "app-upsert-1",
      provider: "google",
      clientId: "abc123",
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    };
    mockOrchestrateOAuthConnect = async () => ({
      success: true,
      deferred: false,
      grantedScopes: [],
    });
    mockGetAppByProviderAndClientId = () => undefined;
    mockGetMostRecentAppByProvider = () => undefined;
    mockGetProvider = () => undefined;
    mockGetSecureKey = () => undefined;
    mockGetCredentialMetadata = () => undefined;
    mockUpsertAppImpl = undefined;
  });

  test("upsert with --client-secret-credential-path passes path to upsertApp", async () => {
    // "custom/path" has no colon and no credential/ or oauth_app/ prefix.
    // resolveCredentialPath passes it through unchanged since it doesn't
    // match the service:field shorthand pattern.
    const { exitCode, stdout } = await runCli([
      "apps",
      "upsert",
      "--provider",
      "google",
      "--client-id",
      "abc123",
      "--client-secret-credential-path",
      "custom/path",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(mockUpsertAppCalls).toHaveLength(1);
    expect(mockUpsertAppCalls[0]).toEqual({
      provider: "google",
      clientId: "abc123",
      clientSecretOpts: { clientSecretCredentialPath: "custom/path" },
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.id).toBe("app-upsert-1");
  });

  test("upsert with both --client-secret and --client-secret-credential-path returns error", async () => {
    const { exitCode, stdout } = await runCli([
      "apps",
      "upsert",
      "--provider",
      "google",
      "--client-id",
      "abc123",
      "--client-secret",
      "s3cret",
      "--client-secret-credential-path",
      "custom/path",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain(
      "Cannot provide both --client-secret and --client-secret-credential-path",
    );
    // upsertApp should NOT have been called
    expect(mockUpsertAppCalls).toHaveLength(0);
  });

  test("upsert with --client-secret passes clientSecretValue to upsertApp", async () => {
    const { exitCode } = await runCli([
      "apps",
      "upsert",
      "--provider",
      "google",
      "--client-id",
      "abc123",
      "--client-secret",
      "s3cret",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(mockUpsertAppCalls).toHaveLength(1);
    expect(mockUpsertAppCalls[0]).toEqual({
      provider: "google",
      clientId: "abc123",
      clientSecretOpts: { clientSecretValue: "s3cret" },
    });
  });

  test("upsert without any secret option passes undefined", async () => {
    const { exitCode } = await runCli([
      "apps",
      "upsert",
      "--provider",
      "google",
      "--client-id",
      "abc123",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(mockUpsertAppCalls).toHaveLength(1);
    expect(mockUpsertAppCalls[0]).toEqual({
      provider: "google",
      clientId: "abc123",
      clientSecretOpts: undefined,
    });
  });

  test("upsert resolves service:field shorthand to full credential path", async () => {
    // The service:field shorthand is resolved to credential/{service}/{field}
    const { exitCode, stdout } = await runCli([
      "apps",
      "upsert",
      "--provider",
      "google",
      "--client-id",
      "abc",
      "--client-secret-credential-path",
      "google:client_secret",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(mockUpsertAppCalls).toHaveLength(1);
    expect(mockUpsertAppCalls[0]).toEqual({
      provider: "google",
      clientId: "abc",
      clientSecretOpts: {
        clientSecretCredentialPath: "credential/google/client_secret",
      },
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.id).toBe("app-upsert-1");
  });

  test("upsert resolves slack:client_secret shorthand to full credential path", async () => {
    const { exitCode, stdout } = await runCli([
      "apps",
      "upsert",
      "--provider",
      "slack",
      "--client-id",
      "slack-abc",
      "--client-secret-credential-path",
      "slack:client_secret",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(mockUpsertAppCalls).toHaveLength(1);
    expect(mockUpsertAppCalls[0]).toEqual({
      provider: "slack",
      clientId: "slack-abc",
      clientSecretOpts: {
        clientSecretCredentialPath: "credential/slack/client_secret",
      },
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.id).toBe("app-upsert-1");
  });

  test("upsert passes prefixed credential path through unchanged", async () => {
    const { exitCode, stdout } = await runCli([
      "apps",
      "upsert",
      "--provider",
      "google",
      "--client-id",
      "abc",
      "--client-secret-credential-path",
      "credential/google/client_secret",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(mockUpsertAppCalls).toHaveLength(1);
    // Already-prefixed path should be passed through as-is
    expect(mockUpsertAppCalls[0]).toEqual({
      provider: "google",
      clientId: "abc",
      clientSecretOpts: {
        clientSecretCredentialPath: "credential/google/client_secret",
      },
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.id).toBe("app-upsert-1");
  });

  test("upsert passes oauth_app/ prefixed credential path through unchanged", async () => {
    const { exitCode, stdout } = await runCli([
      "apps",
      "upsert",
      "--provider",
      "google",
      "--client-id",
      "abc",
      "--client-secret-credential-path",
      "oauth_app/some-id/client_secret",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(mockUpsertAppCalls).toHaveLength(1);
    // oauth_app/ prefixed path should be passed through as-is
    expect(mockUpsertAppCalls[0]).toEqual({
      provider: "google",
      clientId: "abc",
      clientSecretOpts: {
        clientSecretCredentialPath: "oauth_app/some-id/client_secret",
      },
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.id).toBe("app-upsert-1");
  });

  test("upsert with invalid credential path returns error when no secret found", async () => {
    // Override upsertApp to throw when given an unresolvable credential path
    mockUpsertAppImpl = async (_provider, _clientId, clientSecretOpts) => {
      throw new Error(
        `No secret found at credential path: ${clientSecretOpts?.clientSecretCredentialPath}`,
      );
    };

    const { exitCode, stdout } = await runCli([
      "apps",
      "upsert",
      "--provider",
      "google",
      "--client-id",
      "abc",
      "--client-secret-credential-path",
      "bogus:nonexistent:path",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No secret found");
  });
});

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

describe("assistant oauth ping <provider-key>", () => {
  beforeEach(() => {
    mockWithValidToken = async (_service, cb) => cb("mock-access-token-xyz");
    // Reset resolveOAuthConnection to default (unconfigured)
    mockResolveOAuthConnection = async () => {
      throw new Error("resolveOAuthConnection not configured in test");
    };
  });

  test("returns ok when ping endpoint returns 200", async () => {
    mockGetProvider = () => ({
      provider: "google",
      pingUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenExchangeUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: "[]",
      scopePolicy: "{}",
      authorizeParams: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    mockResolveOAuthConnection = async () => ({
      id: "conn-1",
      provider: "google",
      accountInfo: null,
      request: async () => ({ status: 200, headers: {}, body: {} }),
      withToken: async (fn) => fn("mock-access-token-xyz"),
    });
    const { exitCode, stdout } = await runCli(["ping", "google", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe(200);
  });

  test("exits 1 when provider not found", async () => {
    mockGetProvider = () => undefined;
    const { exitCode, stdout } = await runCli(["ping", "unknown", "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Unknown provider");
  });

  test("exits 1 when no ping URL configured", async () => {
    mockGetProvider = () => ({
      provider: "telegram",
      pingUrl: null,
      authorizeUrl: "urn:manual-token",
      tokenExchangeUrl: "urn:manual-token",
      defaultScopes: "[]",
      scopePolicy: "{}",
      authorizeParams: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const { exitCode, stdout } = await runCli(["ping", "telegram", "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No ping URL configured");
  });

  test("exits 1 when ping endpoint returns non-2xx", async () => {
    mockGetProvider = () => ({
      provider: "google",
      pingUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenExchangeUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: "[]",
      scopePolicy: "{}",
      authorizeParams: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    mockResolveOAuthConnection = async () => ({
      id: "conn-1",
      provider: "google",
      accountInfo: null,
      request: async () => ({ status: 403, headers: {}, body: "Forbidden" }),
      withToken: async (fn) => fn("mock-access-token-xyz"),
    });
    const { exitCode, stdout } = await runCli(["ping", "google", "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe(403);
  });

  test("exits 1 when no connection can be resolved", async () => {
    mockGetProvider = () => ({
      provider: "google",
      pingUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenExchangeUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: "[]",
      scopePolicy: "{}",
      authorizeParams: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    mockResolveOAuthConnection = async () => {
      throw new Error('No access token found for "google".');
    };
    const { exitCode, stdout } = await runCli(["ping", "google", "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No access token");
  });
});

// ---------------------------------------------------------------------------
// oauth connect — managed mode 401/403 error messages
// ---------------------------------------------------------------------------

describe("assistant oauth connect managed mode — platform 401/403 errors", () => {
  /**
   * Helper: create a mock platform client whose `fetch` always returns the
   * given status code and body text.
   */
  function makeMockPlatformClient(status: number, body = "") {
    return {
      platformAssistantId: "asst-test-123",
      fetch: async () =>
        new Response(body, { status, statusText: `HTTP ${status}` }),
    };
  }

  beforeEach(() => {
    mockWithValidToken = async (_service, cb) => cb("mock-access-token-xyz");
    mockOrchestrateOAuthConnect = async () => ({
      success: true,
      deferred: false,
      grantedScopes: [],
    });
    mockGetAppByProviderAndClientId = () => undefined;
    mockGetMostRecentAppByProvider = () => undefined;
    mockGetSecureKey = () => undefined;
    mockGetCredentialMetadata = () => undefined;

    // Set up managed mode: provider has managedServiceConfigKey, config
    // returns the matching service with mode "managed".
    mockGetProvider = () => ({
      provider: "google",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenExchangeUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: "[]",
      scopePolicy: "{}",
      authorizeParams: null,
      managedServiceConfigKey: "google-oauth",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    mockGetConfig = () => ({
      services: {
        "google-oauth": { mode: "managed" },
      },
    });
  });

  afterEach(() => {
    mockPlatformClientCreate = async () => null;
    mockGetConfig = () => ({ services: {} });
  });

  test("401 response includes 'vellum platform connect' suggestion", async () => {
    mockPlatformClientCreate = async () =>
      makeMockPlatformClient(401, "Unauthorized");
    const { exitCode, stdout } = await runCli([
      "connect",
      "google",
      "--no-browser",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Platform returned HTTP 401");
    expect(parsed.error).toContain("Unauthorized");
    expect(parsed.error).toContain("vellum platform connect");
  });

  test("403 response includes 'vellum platform connect' suggestion", async () => {
    mockPlatformClientCreate = async () =>
      makeMockPlatformClient(403, "Forbidden");
    const { exitCode, stdout } = await runCli([
      "connect",
      "google",
      "--no-browser",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Platform returned HTTP 403");
    expect(parsed.error).toContain("Forbidden");
    expect(parsed.error).toContain("vellum platform connect");
  });

  test("500 response does NOT include 'vellum platform connect' suggestion", async () => {
    mockPlatformClientCreate = async () =>
      makeMockPlatformClient(500, "Internal Server Error");
    const { exitCode, stdout } = await runCli([
      "connect",
      "google",
      "--no-browser",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Platform returned HTTP 500");
    expect(parsed.error).not.toContain("vellum platform connect");
  });
});

// ---------------------------------------------------------------------------
// requirePlatformClient — improved error messages
// ---------------------------------------------------------------------------

describe("requirePlatformClient", () => {
  test("returns error mentioning 'vellum platform connect' when not connected", async () => {
    mockPlatformClientCreate = async () => null;
    const stdoutChunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.exitCode = 0;

    try {
      const cmd = new Command();
      cmd.option("--json");
      cmd.parse(["node", "test", "--json"]);
      const result = await requirePlatformClient(cmd);
      expect(result).toBeNull();
      expect(process.exitCode).toBe(1);
      const output = stdoutChunks.join("");
      const parsed = JSON.parse(output);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("vellum platform connect");
      expect(parsed.error).toContain("Not connected");
    } finally {
      process.stdout.write = originalWrite;
      process.exitCode = 0;
    }
  });

  test("returns distinct error when connected but missing assistant ID", async () => {
    mockPlatformClientCreate = async () => ({
      platformAssistantId: "",
      fetch: async () => new Response(),
    });
    const stdoutChunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.exitCode = 0;

    try {
      const cmd = new Command();
      cmd.option("--json");
      cmd.parse(["node", "test", "--json"]);
      const result = await requirePlatformClient(cmd);
      expect(result).toBeNull();
      expect(process.exitCode).toBe(1);
      const output = stdoutChunks.join("");
      const parsed = JSON.parse(output);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("no assistant ID is configured");
      expect(parsed.error).toContain("registered on the platform");
    } finally {
      process.stdout.write = originalWrite;
      process.exitCode = 0;
    }
  });

  test("returns client when connected with assistant ID", async () => {
    mockPlatformClientCreate = async () => ({
      platformAssistantId: "asst-123",
      fetch: async () => new Response(),
    });
    process.exitCode = 0;

    const cmd = new Command();
    cmd.option("--json");
    cmd.parse(["node", "test", "--json"]);
    const result = await requirePlatformClient(cmd);
    expect(result).not.toBeNull();
    expect(result!.platformAssistantId).toBe("asst-123");
    expect(process.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// requirePlatformConnection
// ---------------------------------------------------------------------------

describe("requirePlatformConnection", () => {
  test("returns false and writes error when not connected", async () => {
    mockPlatformClientCreate = async () => null;
    const stdoutChunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.exitCode = 0;

    try {
      const cmd = new Command();
      cmd.option("--json");
      cmd.parse(["node", "test", "--json"]);
      const result = await requirePlatformConnection(cmd);
      expect(result).toBe(false);
      expect(process.exitCode).toBe(1);
      const output = stdoutChunks.join("");
      const parsed = JSON.parse(output);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("vellum platform connect");
      expect(parsed.error).toContain("Not connected");
    } finally {
      process.stdout.write = originalWrite;
      process.exitCode = 0;
    }
  });

  test("returns true when client can be created (even without assistant ID)", async () => {
    mockPlatformClientCreate = async () => ({
      platformAssistantId: "",
      fetch: async () => new Response(),
    });
    process.exitCode = 0;

    const cmd = new Command();
    cmd.option("--json");
    cmd.parse(["node", "test", "--json"]);
    const result = await requirePlatformConnection(cmd);
    expect(result).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  test("returns true when client can be created with assistant ID", async () => {
    mockPlatformClientCreate = async () => ({
      platformAssistantId: "asst-456",
      fetch: async () => new Response(),
    });
    process.exitCode = 0;

    const cmd = new Command();
    cmd.option("--json");
    cmd.parse(["node", "test", "--json"]);
    const result = await requirePlatformConnection(cmd);
    expect(result).toBe(true);
    expect(process.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// oauth mode — platform connection guard
// ---------------------------------------------------------------------------

describe("assistant oauth mode", () => {
  beforeEach(() => {
    mockWithValidToken = async (_service, cb) => cb("mock-access-token-xyz");
    mockGetProvider = () => ({
      provider: "google",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenExchangeUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: "[]",
      scopePolicy: "{}",
      authorizeParams: null,
      managedServiceConfigKey: "google-oauth",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    mockGetConfig = () => ({
      services: {
        "google-oauth": { mode: "your-own" },
      },
    });
  });

  afterEach(() => {
    mockPlatformClientCreate = async () => null;
    mockGetConfig = () => ({ services: {} });
    mockGetProvider = () => undefined;
  });

  test("oauth mode <provider> --set managed fails when not connected to platform", async () => {
    mockPlatformClientCreate = async () => null;
    const { exitCode, stdout } = await runCli([
      "mode",
      "google",
      "--set",
      "managed",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("vellum platform connect");
  });

  test("oauth mode <provider> --set your-own succeeds without platform connection", async () => {
    mockPlatformClientCreate = async () => null;
    const { exitCode, stdout } = await runCli([
      "mode",
      "google",
      "--set",
      "your-own",
      "--json",
    ]);
    // Setting to "your-own" doesn't need platform — it's a local-only operation
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe("your-own");
  });

  test("oauth mode <provider> (read) succeeds without platform connection", async () => {
    mockPlatformClientCreate = async () => null;
    const { exitCode, stdout } = await runCli(["mode", "google", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.provider).toBe("google");
    expect(parsed.mode).toBe("your-own");
  });
});

// ---------------------------------------------------------------------------
// providers register / update / get — --scope-separator wiring
// ---------------------------------------------------------------------------

describe("assistant oauth providers --scope-separator", () => {
  beforeEach(() => {
    mockWithValidToken = async (_service, cb) => cb("mock-access-token-xyz");
    mockProviderStore.clear();
    // Default getProvider falls through to mockProviderStore via the
    // oauth-store mock module. Tests in this describe block don't need
    // a per-test mockGetProvider override.
    mockGetProvider = () => undefined;
    mockGetConfig = () => ({ services: {} });
  });

  afterEach(() => {
    mockProviderStore.clear();
    mockGetProvider = () => undefined;
  });

  test("providers register --scope-separator , stores ',' on the provider row", async () => {
    const { exitCode } = await runCli([
      "providers",
      "register",
      "--provider-key",
      "custom-linear",
      "--auth-url",
      "https://linear.app/oauth/authorize",
      "--token-url",
      "https://api.linear.app/oauth/token",
      "--scopes",
      "read,write",
      "--scope-separator",
      ",",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const stored = mockProviderStore.get("custom-linear");
    expect(stored).toBeDefined();
    expect(stored?.scopeSeparator).toBe(",");
  });

  test("providers register without --scope-separator stores the default ' '", async () => {
    const { exitCode } = await runCli([
      "providers",
      "register",
      "--provider-key",
      "custom-default-sep",
      "--auth-url",
      "https://example.com/oauth/authorize",
      "--token-url",
      "https://example.com/oauth/token",
      "--scopes",
      "read,write",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const stored = mockProviderStore.get("custom-default-sep");
    expect(stored).toBeDefined();
    expect(stored?.scopeSeparator).toBe(" ");
  });

  test("providers update --scope-separator , updates an existing custom provider", async () => {
    // Seed the store with an existing custom provider that uses the default
    // " " separator.
    await runCli([
      "providers",
      "register",
      "--provider-key",
      "custom-update-target",
      "--auth-url",
      "https://example.com/oauth/authorize",
      "--token-url",
      "https://example.com/oauth/token",
      "--scopes",
      "read",
      "--json",
    ]);
    expect(mockProviderStore.get("custom-update-target")?.scopeSeparator).toBe(
      " ",
    );

    const { exitCode } = await runCli([
      "providers",
      "update",
      "custom-update-target",
      "--scope-separator",
      ",",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(mockProviderStore.get("custom-update-target")?.scopeSeparator).toBe(
      ",",
    );
  });

  test("providers get <key> --json includes scopeSeparator from the serialized output", async () => {
    // Seed the store with a custom provider that uses ',' as the separator.
    await runCli([
      "providers",
      "register",
      "--provider-key",
      "custom-get-target",
      "--auth-url",
      "https://example.com/oauth/authorize",
      "--token-url",
      "https://example.com/oauth/token",
      "--scopes",
      "read,write",
      "--scope-separator",
      ",",
      "--json",
    ]);

    const { exitCode, stdout } = await runCli([
      "providers",
      "get",
      "custom-get-target",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.scopeSeparator).toBe(",");
  });
});

// ---------------------------------------------------------------------------
// providers register / update / get — --refresh-url wiring
// ---------------------------------------------------------------------------

describe("assistant oauth providers --refresh-url", () => {
  beforeEach(() => {
    mockWithValidToken = async (_service, cb) => cb("mock-access-token-xyz");
    mockProviderStore.clear();
    // Default getProvider falls through to mockProviderStore via the
    // oauth-store mock module.
    mockGetProvider = () => undefined;
    mockGetConfig = () => ({ services: {} });
  });

  afterEach(() => {
    mockProviderStore.clear();
    mockGetProvider = () => undefined;
  });

  test("providers register --refresh-url stores the URL on the provider row", async () => {
    const { exitCode } = await runCli([
      "providers",
      "register",
      "--provider-key",
      "custom-refresh-url",
      "--auth-url",
      "https://example.com/oauth/authorize",
      "--token-url",
      "https://example.com/oauth/token",
      "--refresh-url",
      "https://refresh.example.com/token",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const stored = mockProviderStore.get("custom-refresh-url");
    expect(stored).toBeDefined();
    expect(stored?.refreshUrl).toBe("https://refresh.example.com/token");
  });

  test("providers register without --refresh-url stores null", async () => {
    const { exitCode } = await runCli([
      "providers",
      "register",
      "--provider-key",
      "custom-no-refresh-url",
      "--auth-url",
      "https://example.com/oauth/authorize",
      "--token-url",
      "https://example.com/oauth/token",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const stored = mockProviderStore.get("custom-no-refresh-url");
    expect(stored).toBeDefined();
    expect(stored?.refreshUrl).toBeNull();
  });

  test("providers update --refresh-url updates an existing custom provider", async () => {
    // Seed the store with an existing custom provider that has no refresh URL.
    await runCli([
      "providers",
      "register",
      "--provider-key",
      "custom-update-refresh",
      "--auth-url",
      "https://example.com/oauth/authorize",
      "--token-url",
      "https://example.com/oauth/token",
      "--json",
    ]);
    expect(
      mockProviderStore.get("custom-update-refresh")?.refreshUrl,
    ).toBeNull();

    const { exitCode } = await runCli([
      "providers",
      "update",
      "custom-update-refresh",
      "--refresh-url",
      "https://new-refresh.example.com/token",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(mockProviderStore.get("custom-update-refresh")?.refreshUrl).toBe(
      "https://new-refresh.example.com/token",
    );
  });

  test("providers get <key> --json includes refreshUrl from the serialized output", async () => {
    // Seed the store with a custom provider that has a refresh URL set.
    await runCli([
      "providers",
      "register",
      "--provider-key",
      "custom-get-refresh",
      "--auth-url",
      "https://example.com/oauth/authorize",
      "--token-url",
      "https://example.com/oauth/token",
      "--refresh-url",
      "https://refresh.example.com/token",
      "--json",
    ]);

    const { exitCode, stdout } = await runCli([
      "providers",
      "get",
      "custom-get-refresh",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.refreshUrl).toBe("https://refresh.example.com/token");
  });
});
