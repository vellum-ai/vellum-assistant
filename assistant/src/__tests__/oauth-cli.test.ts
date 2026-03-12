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
  upsertApp: async () => ({}),
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
  getSecureKey: () => undefined,
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
  getCredentialMetadata: () => undefined,
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
  getProviderBehavior: () => undefined,
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
      "integration:gmail",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("gmail-token\n");
    expect(capturedService).toBe("integration:gmail");
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
      "integration:gmail",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.service).toBe("integration:gmail");

    // disconnectOAuthProvider should have been called with the full provider key
    expect(disconnectOAuthProviderCalls).toEqual(["integration:gmail"]);
  });

  test("reports not-found when nothing exists", async () => {
    const result = await runCli([
      "connections",
      "disconnect",
      "integration:gmail",
      "--json",
    ]);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No OAuth connection or credentials");
    expect(parsed.error).toContain("integration:gmail");
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
        credentialKey("integration:gmail", field),
        `legacy_${field}_value`,
      );
      metadataStore.push({
        credentialId: nextUUID(),
        service: "integration:gmail",
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
      "integration:gmail",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.service).toBe("integration:gmail");

    // All legacy keys should be removed
    for (const field of legacyFields) {
      expect(
        secureKeyStore.has(credentialKey("integration:gmail", field)),
      ).toBe(false);
      expect(
        metadataStore.find(
          (m) => m.service === "integration:gmail" && m.field === field,
        ),
      ).toBeUndefined();
    }
  });

  test("cleans up both OAuth connection and legacy keys when both exist", async () => {
    // Seed OAuth connection
    disconnectOAuthProviderResult = "disconnected";

    // Seed a legacy credential key
    secureKeyStore.set(
      credentialKey("integration:gmail", "access_token"),
      "legacy_token",
    );
    metadataStore.push({
      credentialId: nextUUID(),
      service: "integration:gmail",
      field: "access_token",
      allowedTools: [],
      allowedDomains: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const result = await runCli([
      "connections",
      "disconnect",
      "integration:gmail",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);

    // Both should be cleaned up
    expect(disconnectOAuthProviderCalls).toEqual(["integration:gmail"]);
    expect(
      secureKeyStore.has(credentialKey("integration:gmail", "access_token")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// providers list
// ---------------------------------------------------------------------------

describe("assistant oauth providers list", () => {
  const fakeProviders = [
    {
      providerKey: "integration:gmail",
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
    expect(keys).toContain("integration:gmail");
    expect(keys).toContain("integration:google-calendar");
    expect(keys).toContain("integration:slack");
    expect(keys).toContain("integration:twitter");
  });

  test("filters by single --provider-key value", async () => {
    const { exitCode, stdout } = await runCli([
      "providers",
      "list",
      "--provider-key",
      "gmail",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].providerKey).toBe("integration:gmail");
  });

  test("filters by comma-separated OR values", async () => {
    const { exitCode, stdout } = await runCli([
      "providers",
      "list",
      "--provider-key",
      "gmail,google",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveLength(2);
    const keys = parsed.map((p: { providerKey: string }) => p.providerKey);
    expect(keys).toContain("integration:gmail");
    expect(keys).toContain("integration:google-calendar");
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
      "gmail, google",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveLength(2);
    const keys = parsed.map((p: { providerKey: string }) => p.providerKey);
    expect(keys).toContain("integration:gmail");
    expect(keys).toContain("integration:google-calendar");
  });

  test("ignores empty segments from extra commas in --provider-key", async () => {
    const { exitCode, stdout } = await runCli([
      "providers",
      "list",
      "--provider-key",
      "gmail,,google",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveLength(2);
    const keys = parsed.map((p: { providerKey: string }) => p.providerKey);
    expect(keys).toContain("integration:gmail");
    expect(keys).toContain("integration:google-calendar");
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
  });

  test("completes interactive flow and prints success (human mode)", async () => {
    mockOrchestrateOAuthConnect = async () => ({
      success: true,
      deferred: false,
      grantedScopes: ["read"],
      accountInfo: "user@example.com",
    });

    const { exitCode, stdout } = await runCli([
      "connections",
      "connect",
      "integration:gmail",
      "--client-id",
      "test-id",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Connected");
  });

  test("returns auth URL in url-only mode (JSON)", async () => {
    mockOrchestrateOAuthConnect = async () => ({
      success: true,
      deferred: true,
      authUrl: "https://example.com/auth",
      state: "abc",
      service: "integration:gmail",
    });

    const { exitCode, stdout } = await runCli([
      "connections",
      "connect",
      "integration:gmail",
      "--client-id",
      "test-id",
      "--url-only",
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
      "integration:gmail",
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
      providerKey: "integration:gmail",
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

    await runCli(["connections", "connect", "integration:gmail"]);
    expect(capturedClientId).toBe("db-client-id");
  });

  test("outputs error from orchestrator", async () => {
    mockOrchestrateOAuthConnect = async () => ({
      success: false,
      error: "Something went wrong",
    });

    const { exitCode, stdout } = await runCli([
      "connections",
      "connect",
      "integration:gmail",
      "--client-id",
      "x",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("Something went wrong");
  });
});
