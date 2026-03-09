import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockWithValidToken: <T>(
  service: string,
  cb: (token: string) => Promise<T>,
) => Promise<T>;

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

// Stub out transitive dependencies that token-manager would normally pull in
mock.module("../security/secure-keys.js", () => ({
  getSecureKey: () => undefined,
  setSecureKey: () => true,
  getSecureKeyAsync: async () => undefined,
  setSecureKeyAsync: async () => true,
  deleteSecureKey: () => "not-found",
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadata: () => undefined,
  upsertCredentialMetadata: () => ({}),
  listCredentialMetadata: () => [],
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

const { registerOAuthCommand } = await import("../cli/commands/oauth.js");

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

describe("assistant oauth token", () => {
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

  test("qualifies service name with integration: prefix", async () => {
    let capturedService: string | undefined;
    mockWithValidToken = async (service, cb) => {
      capturedService = service;
      return cb("tok");
    };

    await runCli(["token", "twitter"]);
    expect(capturedService).toBe("integration:twitter");
  });

  test("works with other service names", async () => {
    let capturedService: string | undefined;
    mockWithValidToken = async (service, cb) => {
      capturedService = service;
      return cb("gmail-token");
    };

    const { exitCode, stdout } = await runCli(["token", "gmail"]);
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

    const { exitCode, stdout } = await runCli(["token", "twitter", "--json"]);
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

  test("missing service argument exits non-zero", async () => {
    const { exitCode } = await runCli(["token"]);
    expect(exitCode).not.toBe(0);
  });
});
