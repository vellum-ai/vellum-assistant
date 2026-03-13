import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

import { credentialKey } from "../security/credential-key.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockWithValidToken: <T>(
  service: string,
  cb: (token: string) => Promise<T>,
) => Promise<T>;

// Disconnect mock state
let mockListProviders: () => Array<Record<string, unknown>> = () => [];
let secureKeyStore = new Map<string, string>();
let metadataStore: Array<{
  credentialId: string;
  service: string;
  field: string;
  allowedTools: string[];
  allowedDomains: string[];
  createdAt: number;
  updatedAt: number;
}> = [];
let disconnectOAuthProviderCalls: string[] = [];
let disconnectOAuthProviderResult: "disconnected" | "not-found" | "error" =
  "not-found";
let idCounter = 0;

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
  providerKey: "integration:test",
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

// Connect mock state
let mockOrchestrateOAuthConnect: (
  opts: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
let mockGetAppByProviderAndClientId: (
  providerKey: string,
  clientId: string,
) => Record<string, unknown> | undefined = () => undefined;
let mockGetMostRecentAppByProvider: (
  providerKey: string,
) => Record<string, unknown> | undefined = () => undefined;
let mockGetProvider: (
  providerKey: string,
) => Record<string, unknown> | undefined = () => undefined;
let mockGetProviderBehavior: (
  providerKey: string,
) => Record<string, unknown> | undefined = () => undefined;
let mockGetSecureKey: (account: string) => string | undefined = () => undefined;
let mockGetCredentialMetadata: (
  service: string,
  field: string,
) => Record<string, unknown> | undefined = () => undefined;

function nextUUID(): string {
  idCounter += 1;
  return `00000000-0000-0000-0000-${String(idCounter).padStart(12, "0")}`;
}

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
// Mock oauth-store (stateful for disconnect tests)
// ---------------------------------------------------------------------------

mock.module("../oauth/oauth-store.js", () => ({
  disconnectOAuthProvider: async (
    providerKey: string,
  ): Promise<"disconnected" | "not-found" | "error"> => {
    disconnectOAuthProviderCalls.push(providerKey);
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
  getAppByProviderAndClientId: (providerKey: string, clientId: string) =>
    mockGetAppByProviderAndClientId(providerKey, clientId),
  getMostRecentAppByProvider: (providerKey: string) =>
    mockGetMostRecentAppByProvider(providerKey),
  listApps: () => [],
  deleteApp: async () => false,
  getProvider: (providerKey: string) => mockGetProvider(providerKey),
  listProviders: () => mockListProviders(),
  registerProvider: () => ({}),
  seedProviders: () => {},
  createConnection: () => ({}),
  isProviderConnected: () => false,
  updateConnection: () => ({}),
}));

// Stub out transitive dependencies that token-manager would normally pull in
mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (account: string) => mockGetSecureKey(account),
  setSecureKey: () => true,
  getSecureKeyAsync: async () => undefined,
  setSecureKeyAsync: async () => true,
  deleteSecureKey: (account: string) => {
    if (secureKeyStore.has(account)) {
      secureKeyStore.delete(account);
      return "deleted" as const;
    }
    return "not-found" as const;
  },
  deleteSecureKeyAsync: async (account: string) => {
    if (secureKeyStore.has(account)) {
      secureKeyStore.delete(account);
      return "deleted" as const;
    }
    return "not-found" as const;
  },
  listSecureKeys: () => [...secureKeyStore.keys()],
  getBackendType: () => "encrypted",
  isDowngradedFromKeychain: () => false,
  _resetBackend: () => {},
  _setBackend: () => {},
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

// ---------------------------------------------------------------------------
// Mock provider-behaviors
// ---------------------------------------------------------------------------

mock.module("../oauth/provider-behaviors.js", () => ({
  resolveService: (service: string) => service,
  getProviderBehavior: (providerKey: string) =>
    mockGetProviderBehavior(providerKey),
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

describe("assistant oauth connections token <provider-key>", () => {
  beforeEach(() => {
    mockWithValidToken = async (_service, cb) => cb("mock-access-token-xyz");
    secureKeyStore = new Map();
    metadataStore = [];
    disconnectOAuthProviderCalls = [];
    disconnectOAuthProviderResult = "not-found";
    idCounter = 0;
  });

  test("prints bare token in human mode", async () => {
    const { exitCode, stdout } = await runCli([
      "connections",
      "token",
      "integration:twitter",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("mock-access-token-xyz\n");
  });

  test("prints JSON in --json mode", async () => {
    const { exitCode, stdout } = await runCli([
      "connections",
      "token",
      "integration:twitter",
      "--json",
    ]);
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

    await runCli(["connections", "token", "integration:twitter"]);
    expect(capturedService).toBe("integration:twitter");
  });

  test("works with other provider keys", async () => {
    let capturedService: string | undefined;
    mockWithValidToken = async (service, cb) => {
      capturedService = service;
      return cb("gmail-token");
    };

    const { exitCode, stdout } = await runCli([
      "connections",
      "token",
      "integration:google",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("gmail-token\n");
    expect(capturedService).toBe("integration:google");
  });

  test("exits 1 when no token exists", async () => {
    mockWithValidToken = async () => {
      throw new Error(
        'No access token found for "integration:twitter". Authorization required.',
      );
    };

    const { exitCode, stdout } = await runCli([
      "connections",
      "token",
      "integration:twitter",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No access token found");
  });

  test("exits 1 when refresh fails", async () => {
    mockWithValidToken = async () => {
      throw new Error(
        'Token refresh failed for "integration:twitter": invalid_grant.',
      );
    };

    const { exitCode, stdout } = await runCli([
      "connections",
      "token",
      "integration:twitter",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Token refresh failed");
  });

  test("returns refreshed token transparently", async () => {
    // Simulate withValidToken refreshing and returning a new token
    mockWithValidToken = async (_service, cb) => cb("refreshed-new-token");

    const { exitCode, stdout } = await runCli([
      "connections",
      "token",
      "integration:twitter",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("refreshed-new-token\n");
  });

  test("missing provider-key argument exits non-zero", async () => {
    const { exitCode } = await runCli(["connections", "token"]);
    expect(exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// disconnect
// ---------------------------------------------------------------------------

describe("assistant oauth connections disconnect <provider-key>", () => {
  beforeEach(() => {
    mockWithValidToken = async (_service, cb) => cb("mock-access-token-xyz");
    secureKeyStore = new Map();
    metadataStore = [];
    disconnectOAuthProviderCalls = [];
    disconnectOAuthProviderResult = "not-found";
    idCounter = 0;
  });

  test("succeeds when an OAuth connection exists", async () => {
    disconnectOAuthProviderResult = "disconnected";

    const result = await runCli([
      "connections",
      "disconnect",
      "integration:google",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.service).toBe("integration:google");

    // disconnectOAuthProvider should have been called with the full provider key
    expect(disconnectOAuthProviderCalls).toEqual(["integration:google"]);
  });

  test("reports not-found when nothing exists", async () => {
    const result = await runCli([
      "connections",
      "disconnect",
      "integration:google",
      "--json",
    ]);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No OAuth connection or credentials");
    expect(parsed.error).toContain("integration:google");
  });

  test("cleans up legacy credential keys if present", async () => {
    // Seed legacy credential keys (no OAuth connection)
    const legacyFields = [
      "access_token",
      "refresh_token",
      "client_id",
      "client_secret",
    ];
    for (const field of legacyFields) {
      secureKeyStore.set(
        credentialKey("integration:google", field),
        `legacy_${field}_value`,
      );
      metadataStore.push({
        credentialId: nextUUID(),
        service: "integration:google",
        field,
        allowedTools: [],
        allowedDomains: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    const result = await runCli([
      "connections",
      "disconnect",
      "integration:google",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.service).toBe("integration:google");

    // All legacy keys should be removed
    for (const field of legacyFields) {
      expect(
        secureKeyStore.has(credentialKey("integration:google", field)),
      ).toBe(false);
      expect(
        metadataStore.find(
          (m) => m.service === "integration:google" && m.field === field,
        ),
      ).toBeUndefined();
    }
  });

  test("cleans up both OAuth connection and legacy keys when both exist", async () => {
    // Seed OAuth connection
    disconnectOAuthProviderResult = "disconnected";

    // Seed a legacy credential key
    secureKeyStore.set(
      credentialKey("integration:google", "access_token"),
      "legacy_token",
    );
    metadataStore.push({
      credentialId: nextUUID(),
      service: "integration:google",
      field: "access_token",
      allowedTools: [],
      allowedDomains: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const result = await runCli([
      "connections",
      "disconnect",
      "integration:google",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);

    // Both should be cleaned up
    expect(disconnectOAuthProviderCalls).toEqual(["integration:google"]);
    expect(
      secureKeyStore.has(credentialKey("integration:google", "access_token")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// providers list
// ---------------------------------------------------------------------------

describe("assistant oauth providers list", () => {
  const fakeProviders = [
    {
      providerKey: "integration:google",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: "[]",
      scopePolicy: "{}",
      extraParams: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
    {
      providerKey: "integration:google-calendar",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: "[]",
      scopePolicy: "{}",
      extraParams: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
    {
      providerKey: "integration:slack",
      authUrl: "https://slack.com/oauth/v2/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      defaultScopes: "[]",
      scopePolicy: "{}",
      extraParams: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
    {
      providerKey: "integration:twitter",
      authUrl: "https://twitter.com/i/oauth2/authorize",
      tokenUrl: "https://api.twitter.com/2/oauth2/token",
      defaultScopes: "[]",
      scopePolicy: "{}",
      extraParams: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
  ];

  beforeEach(() => {
    mockWithValidToken = async (_service, cb) => cb("mock-access-token-xyz");
    mockListProviders = () => fakeProviders;
    secureKeyStore = new Map();
    metadataStore = [];
    disconnectOAuthProviderCalls = [];
    disconnectOAuthProviderResult = "not-found";
    idCounter = 0;
  });

  test("returns all providers when no --provider-key is given", async () => {
    const { exitCode, stdout } = await runCli(["providers", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveLength(4);
    const keys = parsed.map((p: { providerKey: string }) => p.providerKey);
    expect(keys).toContain("integration:google");
    expect(keys).toContain("integration:google-calendar");
    expect(keys).toContain("integration:slack");
    expect(keys).toContain("integration:twitter");
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
    expect(parsed[0].providerKey).toBe("integration:slack");
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
    expect(keys).toContain("integration:google");
    expect(keys).toContain("integration:google-calendar");
    expect(keys).toContain("integration:slack");
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
    expect(keys).toContain("integration:google");
    expect(keys).toContain("integration:google-calendar");
    expect(keys).toContain("integration:slack");
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
    expect(keys).toContain("integration:google");
    expect(keys).toContain("integration:google-calendar");
    expect(keys).toContain("integration:slack");
  });
});

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

describe("assistant oauth connections connect <provider-key>", () => {
  beforeEach(() => {
    mockWithValidToken = async (_service, cb) => cb("mock-access-token-xyz");
    secureKeyStore = new Map();
    metadataStore = [];
    disconnectOAuthProviderCalls = [];
    disconnectOAuthProviderResult = "not-found";
    idCounter = 0;
    mockOrchestrateOAuthConnect = async () => ({
      success: true,
      deferred: false,
      grantedScopes: [],
    });
    mockGetAppByProviderAndClientId = () => undefined;
    mockGetMostRecentAppByProvider = () => undefined;
    mockGetProvider = () => undefined;
    mockGetProviderBehavior = () => undefined;
    mockGetSecureKey = () => undefined;
  });

  test("completes interactive flow and prints success (human mode)", async () => {
    mockGetAppByProviderAndClientId = () => ({
      id: "app-1",
      clientId: "test-id",
      clientSecretCredentialPath: "oauth_app/app-1/client_secret",
      providerKey: "integration:google",
      createdAt: 0,
      updatedAt: 0,
    });
    mockOrchestrateOAuthConnect = async () => ({
      success: true,
      deferred: false,
      grantedScopes: ["read"],
      accountInfo: "user@example.com",
    });

    const { exitCode, stdout } = await runCli([
      "connections",
      "connect",
      "integration:google",
      "--client-id",
      "test-id",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Connected");
  });

  test("completes interactive flow and returns JSON with --json flag", async () => {
    mockGetAppByProviderAndClientId = () => ({
      id: "app-1",
      clientId: "test-id",
      clientSecretCredentialPath: "oauth_app/app-1/client_secret",
      providerKey: "integration:google",
      createdAt: 0,
      updatedAt: 0,
    });
    mockOrchestrateOAuthConnect = async () => ({
      success: true,
      deferred: false,
      grantedScopes: ["read"],
      accountInfo: "user@example.com",
    });

    const { exitCode, stdout } = await runCli([
      "connections",
      "connect",
      "integration:google",
      "--client-id",
      "test-id",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({
      ok: true,
      grantedScopes: ["read"],
      accountInfo: "user@example.com",
    });
  });

  test("returns auth URL in default (non-interactive) mode (JSON)", async () => {
    mockGetAppByProviderAndClientId = () => ({
      id: "app-1",
      clientId: "test-id",
      clientSecretCredentialPath: "oauth_app/app-1/client_secret",
      providerKey: "integration:google",
      createdAt: 0,
      updatedAt: 0,
    });
    mockOrchestrateOAuthConnect = async () => ({
      success: true,
      deferred: true,
      authUrl: "https://example.com/auth",
      state: "abc",
      service: "integration:google",
    });

    const { exitCode, stdout } = await runCli([
      "connections",
      "connect",
      "integration:google",
      "--client-id",
      "test-id",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.deferred).toBe(true);
    expect(parsed.authUrl).toBe("https://example.com/auth");
  });

  test("fails when no client_id available", async () => {
    mockGetMostRecentAppByProvider = () => undefined;

    const { exitCode, stdout } = await runCli([
      "connections",
      "connect",
      "integration:google",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("client_id");
  });

  test("resolves client_id from DB when not provided", async () => {
    mockGetMostRecentAppByProvider = () => ({
      id: "app-1",
      clientId: "db-client-id",
      clientSecretCredentialPath: "oauth_app/app-1/client_secret",
      providerKey: "integration:google",
      createdAt: 0,
      updatedAt: 0,
    });

    let capturedClientId: string | undefined;
    mockOrchestrateOAuthConnect = async (opts) => {
      capturedClientId = opts.clientId as string;
      return {
        success: true,
        deferred: false,
        grantedScopes: [],
      };
    };

    await runCli(["connections", "connect", "integration:google"]);
    expect(capturedClientId).toBe("db-client-id");
  });

  test("resolves client_secret from secure store when not provided", async () => {
    mockGetMostRecentAppByProvider = () => ({
      id: "app-1",
      clientId: "db-client-id",
      clientSecretCredentialPath: "oauth_app/app-1/client_secret",
      providerKey: "integration:google",
      createdAt: 0,
      updatedAt: 0,
    });

    mockGetSecureKey = (account: string) =>
      account === "oauth_app/app-1/client_secret" ? "db-secret" : undefined;

    let capturedOpts: Record<string, unknown> | undefined;
    mockOrchestrateOAuthConnect = async (opts) => {
      capturedOpts = opts;
      return {
        success: true,
        deferred: false,
        grantedScopes: [],
      };
    };

    await runCli(["connections", "connect", "integration:google"]);
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts!.clientId).toBe("db-client-id");
    expect(capturedOpts!.clientSecret).toBe("db-secret");
  });

  test("outputs error from orchestrator", async () => {
    mockGetAppByProviderAndClientId = () => ({
      id: "app-1",
      clientId: "x",
      clientSecretCredentialPath: "oauth_app/app-1/client_secret",
      providerKey: "integration:google",
      createdAt: 0,
      updatedAt: 0,
    });
    mockOrchestrateOAuthConnect = async () => ({
      success: false,
      error: "Something went wrong",
    });

    const { exitCode, stdout } = await runCli([
      "connections",
      "connect",
      "integration:google",
      "--client-id",
      "x",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("Something went wrong");
  });

  test("succeeds when callbackTransport is null (loopback default)", async () => {
    // Provider row has callbackTransport: null — orchestrator should default
    // to loopback and not require a public ingress URL.
    mockGetMostRecentAppByProvider = () => ({
      id: "app-loopback",
      clientId: "loopback-client",
      clientSecretCredentialPath: "oauth_app/app-loopback/client_secret",
      providerKey: "integration:test-loopback",
      createdAt: 0,
      updatedAt: 0,
    });

    let capturedOpts: Record<string, unknown> | undefined;
    mockOrchestrateOAuthConnect = async (opts) => {
      capturedOpts = opts;
      return {
        success: true,
        deferred: true,
        authUrl: "https://example.com/auth?loopback",
        state: "state-loopback",
        service: "integration:test-loopback",
      };
    };

    const { exitCode, stdout } = await runCli([
      "connections",
      "connect",
      "integration:test-loopback",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.deferred).toBe(true);
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts!.clientId).toBe("loopback-client");
  });

  test("returns ingress URL error when callbackTransport is explicitly gateway", async () => {
    // Provider row has callbackTransport: "gateway" — orchestrator should
    // require a public ingress URL, which is not configured in the test env.
    mockGetMostRecentAppByProvider = () => ({
      id: "app-gateway",
      clientId: "gateway-client",
      clientSecretCredentialPath: "oauth_app/app-gateway/client_secret",
      providerKey: "integration:test-gateway",
      createdAt: 0,
      updatedAt: 0,
    });

    mockOrchestrateOAuthConnect = async () => ({
      success: false,
      error:
        "oauth2_connect from a non-interactive session requires a public ingress URL. Configure ingress.publicBaseUrl first.",
    });

    const { exitCode, stdout } = await runCli([
      "connections",
      "connect",
      "integration:test-gateway",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("requires a public ingress URL");
  });

  test("fails when client_secret is required but missing", async () => {
    mockGetAppByProviderAndClientId = () => ({
      id: "app-1",
      clientId: "test-id",
      clientSecretCredentialPath: "oauth_app/app-1/client_secret",
      providerKey: "integration:google",
      createdAt: 0,
      updatedAt: 0,
    });
    mockGetProviderBehavior = () => ({
      setup: {
        requiresClientSecret: true,
        displayName: "Test",
        dashboardUrl: "https://example.com",
        appType: "app",
      },
    });

    const { exitCode, stdout } = await runCli([
      "connections",
      "connect",
      "integration:google",
      "--client-id",
      "test-id",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("client_secret");
    expect(parsed.error).toContain("apps upsert");
  });
});

// ---------------------------------------------------------------------------
// apps upsert --client-secret-credential-path
// ---------------------------------------------------------------------------

describe("assistant oauth apps upsert --client-secret-credential-path", () => {
  beforeEach(() => {
    mockWithValidToken = async (_service, cb) => cb("mock-access-token-xyz");
    secureKeyStore = new Map();
    metadataStore = [];
    disconnectOAuthProviderCalls = [];
    disconnectOAuthProviderResult = "not-found";
    idCounter = 0;
    mockUpsertAppCalls = [];
    mockUpsertAppResult = {
      id: "app-upsert-1",
      providerKey: "integration:google",
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
    mockGetProviderBehavior = () => undefined;
    mockGetSecureKey = () => undefined;
    mockGetCredentialMetadata = () => undefined;
    mockUpsertAppImpl = undefined;
  });

  test("upsert with --client-secret-credential-path passes path to upsertApp", async () => {
    const { exitCode, stdout } = await runCli([
      "apps",
      "upsert",
      "--provider",
      "integration:google",
      "--client-id",
      "abc123",
      "--client-secret-credential-path",
      "custom/path",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(mockUpsertAppCalls).toHaveLength(1);
    expect(mockUpsertAppCalls[0]).toEqual({
      provider: "integration:google",
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
      "integration:google",
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
      "integration:google",
      "--client-id",
      "abc123",
      "--client-secret",
      "s3cret",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(mockUpsertAppCalls).toHaveLength(1);
    expect(mockUpsertAppCalls[0]).toEqual({
      provider: "integration:google",
      clientId: "abc123",
      clientSecretOpts: { clientSecretValue: "s3cret" },
    });
  });

  test("upsert without any secret option passes undefined", async () => {
    const { exitCode } = await runCli([
      "apps",
      "upsert",
      "--provider",
      "integration:google",
      "--client-id",
      "abc123",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(mockUpsertAppCalls).toHaveLength(1);
    expect(mockUpsertAppCalls[0]).toEqual({
      provider: "integration:google",
      clientId: "abc123",
      clientSecretOpts: undefined,
    });
  });

  test("upsert resolves non-prefixed credential path via metadata store", async () => {
    // The resolution logic splits on the LAST colon, so
    // "integration:google:client_secret" → service="integration:google", field="client_secret"
    mockGetCredentialMetadata = (service, field) =>
      service === "integration:google" && field === "client_secret"
        ? {
            credentialId: "cred-1",
            service: "integration:google",
            field: "client_secret",
            allowedTools: [],
            allowedDomains: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
        : undefined;

    const { exitCode, stdout } = await runCli([
      "apps",
      "upsert",
      "--provider",
      "integration:google",
      "--client-id",
      "abc",
      "--client-secret-credential-path",
      "integration:google:client_secret",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(mockUpsertAppCalls).toHaveLength(1);
    // The non-prefixed path should have been resolved to the full credential key
    expect(mockUpsertAppCalls[0]).toEqual({
      provider: "integration:google",
      clientId: "abc",
      clientSecretOpts: {
        clientSecretCredentialPath:
          "credential/integration:google/client_secret",
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
      "integration:google",
      "--client-id",
      "abc",
      "--client-secret-credential-path",
      "credential/integration:google/client_secret",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(mockUpsertAppCalls).toHaveLength(1);
    // Already-prefixed path should be passed through as-is
    expect(mockUpsertAppCalls[0]).toEqual({
      provider: "integration:google",
      clientId: "abc",
      clientSecretOpts: {
        clientSecretCredentialPath:
          "credential/integration:google/client_secret",
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
      "integration:google",
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

describe("assistant oauth connections ping <provider-key>", () => {
  beforeEach(() => {
    mockWithValidToken = async (_service, cb) => cb("mock-access-token-xyz");
    secureKeyStore = new Map();
    metadataStore = [];
    disconnectOAuthProviderCalls = [];
    disconnectOAuthProviderResult = "not-found";
    idCounter = 0;
  });

  test("returns ok when ping endpoint returns 200", async () => {
    mockGetProvider = () => ({
      providerKey: "integration:google",
      pingUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: "[]",
      scopePolicy: "{}",
      extraParams: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("{}", { status: 200 })) as unknown as typeof fetch;
    try {
      const { exitCode, stdout } = await runCli([
        "connections",
        "ping",
        "integration:google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("exits 1 when provider not found", async () => {
    mockGetProvider = () => undefined;
    const { exitCode, stdout } = await runCli([
      "connections",
      "ping",
      "integration:unknown",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Provider not found");
  });

  test("exits 1 when no ping URL configured", async () => {
    mockGetProvider = () => ({
      providerKey: "telegram",
      pingUrl: null,
      authUrl: "urn:manual-token",
      tokenUrl: "urn:manual-token",
      defaultScopes: "[]",
      scopePolicy: "{}",
      extraParams: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const { exitCode, stdout } = await runCli([
      "connections",
      "ping",
      "telegram",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No ping URL configured");
  });

  test("exits 1 when ping endpoint returns non-2xx", async () => {
    mockGetProvider = () => ({
      providerKey: "integration:google",
      pingUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: "[]",
      scopePolicy: "{}",
      extraParams: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const originalFetch = globalThis.fetch;
    // Use 403 (not 401) — 401 now throws inside withValidToken for retry
    globalThis.fetch = (async () =>
      new Response("Forbidden", { status: 403 })) as unknown as typeof fetch;
    try {
      const { exitCode, stdout } = await runCli([
        "connections",
        "ping",
        "integration:google",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.status).toBe(403);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("exits 1 when no token exists", async () => {
    mockWithValidToken = async () => {
      throw new Error('No access token found for "integration:google".');
    };
    mockGetProvider = () => ({
      providerKey: "integration:google",
      pingUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: "[]",
      scopePolicy: "{}",
      extraParams: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const { exitCode, stdout } = await runCli([
      "connections",
      "ping",
      "integration:google",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No access token");
  });
});
