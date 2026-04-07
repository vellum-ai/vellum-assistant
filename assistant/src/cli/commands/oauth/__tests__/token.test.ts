import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockIsManagedMode: (key: string) => boolean = () => false;

let mockGetActiveConnection: (
  provider: string,
  options?: { clientId?: string; account?: string },
) => Record<string, unknown> | undefined = () => undefined;

let mockWithValidToken: (
  service: string,
  callback: (token: string) => Promise<string>,
  opts?: string | { connectionId: string },
) => Promise<string> = async (_service, callback) => callback("mock-token");

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => ({ services: {} }),
  API_KEY_PROVIDERS: [],
}));

mock.module("../../../../oauth/oauth-store.js", () => ({
  getProvider: () => undefined,
  listConnections: () => [],
  getConnection: () => undefined,
  getConnectionByProvider: () => undefined,
  getActiveConnection: (
    provider: string,
    options?: { clientId?: string; account?: string },
  ) => mockGetActiveConnection(provider, options),
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

mock.module("../../../../security/token-manager.js", () => ({
  withValidToken: async (
    service: string,
    callback: (token: string) => Promise<string>,
    opts?: string | { connectionId: string },
  ) => mockWithValidToken(service, callback, opts),
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
  isManagedMode: (key: string) => mockIsManagedMode(key),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks are registered)
// ---------------------------------------------------------------------------

const { registerTokenCommand } = await import("../token.js");

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
    registerTokenCommand(program);
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

describe("assistant oauth token", () => {
  beforeEach(() => {
    mockIsManagedMode = () => false;
    mockGetActiveConnection = () => undefined;
    mockWithValidToken = async (_service, callback) => callback("mock-token");
    delete process.env.VELLUM_UNTRUSTED_SHELL;
    process.exitCode = 0;
  });

  // =========================================================================
  // BYO mode — successful token retrieval
  // =========================================================================

  describe("BYO mode", () => {
    test("returns token in JSON mode", async () => {
      const { exitCode, stdout } = await runCommand([
        "token",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.token).toBe("mock-token");
    });

    test("prints bare token to stdout in human mode", async () => {
      const { exitCode, stdout } = await runCommand(["token", "google"]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("mock-token");
    });

    test("token refresh failure returns error", async () => {
      mockWithValidToken = async () => {
        throw new Error("Token refresh failed: refresh_token expired");
      };

      const { exitCode, stdout } = await runCommand([
        "token",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Token refresh failed");
    });

    test("no active connection returns error", async () => {
      mockWithValidToken = async () => {
        throw new Error(
          'No access token found for "google". Authorization required.',
        );
      };

      const { exitCode, stdout } = await runCommand([
        "token",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("No access token found");
    });
  });

  // =========================================================================
  // Managed mode — user-friendly error
  // =========================================================================

  test("managed mode returns user-friendly error", async () => {
    mockIsManagedMode = () => true;

    const { exitCode, stdout } = await runCommand([
      "token",
      "google",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("platform-managed");
    expect(parsed.error).toContain("oauth ping");
    expect(parsed.error).toContain("oauth request");
  });

  // =========================================================================
  // CES shell lockdown
  // =========================================================================

  test("blocked with VELLUM_UNTRUSTED_SHELL=1", async () => {
    process.env.VELLUM_UNTRUSTED_SHELL = "1";

    const { exitCode, stdout } = await runCommand([
      "token",
      "google",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("untrusted shell");
  });

  test("allowed when VELLUM_UNTRUSTED_SHELL is not set", async () => {
    delete process.env.VELLUM_UNTRUSTED_SHELL;

    const { exitCode, stdout } = await runCommand([
      "token",
      "google",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.token).toBe("mock-token");
  });

  // =========================================================================
  // --account option for BYO disambiguation
  // =========================================================================

  describe("--account option", () => {
    test("resolves connection by account and uses connectionId", async () => {
      mockGetActiveConnection = (_provider, options) => {
        if (options?.account === "user@gmail.com") {
          return {
            id: "conn-abc-123",
            provider: "google",
            accountInfo: "user@gmail.com",
            status: "active",
          };
        }
        return undefined;
      };

      let calledOpts: unknown;
      mockWithValidToken = async (_service, callback, opts) => {
        calledOpts = opts;
        return callback("account-specific-token");
      };

      const { exitCode, stdout } = await runCommand([
        "token",
        "google",
        "--account",
        "user@gmail.com",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.token).toBe("account-specific-token");
      expect(calledOpts).toEqual({ connectionId: "conn-abc-123" });
    });

    test("no matching account returns error", async () => {
      mockGetActiveConnection = () => undefined;

      const { exitCode, stdout } = await runCommand([
        "token",
        "google",
        "--account",
        "unknown@gmail.com",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("No active connection found");
      expect(parsed.error).toContain("unknown@gmail.com");
      expect(parsed.error).toContain("oauth connect");
    });
  });

  // =========================================================================
  // --client-id option for BYO disambiguation
  // =========================================================================

  describe("--client-id option", () => {
    test("resolves connection by client-id and uses connectionId", async () => {
      mockGetActiveConnection = (_provider, options) => {
        if (options?.clientId === "my-client-id") {
          return {
            id: "conn-client-456",
            provider: "google",
            accountInfo: null,
            status: "active",
          };
        }
        return undefined;
      };

      let calledOpts: unknown;
      mockWithValidToken = async (_service, callback, opts) => {
        calledOpts = opts;
        return callback("client-id-token");
      };

      const { exitCode, stdout } = await runCommand([
        "token",
        "google",
        "--client-id",
        "my-client-id",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.token).toBe("client-id-token");
      expect(calledOpts).toEqual({ connectionId: "conn-client-456" });
    });

    test("no matching client-id returns error", async () => {
      mockGetActiveConnection = () => undefined;

      const { exitCode, stdout } = await runCommand([
        "token",
        "google",
        "--client-id",
        "nonexistent-id",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("No active connection found");
      expect(parsed.error).toContain("nonexistent-id");
    });
  });

  // =========================================================================
  // JSON vs human output
  // =========================================================================

  test("JSON output includes ok and token fields", async () => {
    const { exitCode, stdout } = await runCommand([
      "token",
      "google",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("ok", true);
    expect(parsed).toHaveProperty("token");
    expect(typeof parsed.token).toBe("string");
  });

  test("human output prints bare token without JSON wrapper", async () => {
    mockWithValidToken = async (_service, callback) =>
      callback("bare-token-value");

    const { exitCode, stdout } = await runCommand(["token", "google"]);
    expect(exitCode).toBe(0);
    // Human mode should NOT contain JSON structure
    expect(stdout).not.toContain("{");
    expect(stdout).not.toContain('"ok"');
    expect(stdout.trim()).toBe("bare-token-value");
  });

  test("JSON error output includes ok and error fields", async () => {
    mockWithValidToken = async () => {
      throw new Error("Something went wrong");
    };

    const { exitCode, stdout } = await runCommand([
      "token",
      "google",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("ok", false);
    expect(parsed).toHaveProperty("error");
    expect(typeof parsed.error).toBe("string");
  });
});
