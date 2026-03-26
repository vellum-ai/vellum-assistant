import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockGetSecureKeyViaDaemon: (
  account: string,
) => Promise<string | undefined> = async () => undefined;

let mockDeleteSecureKeyViaDaemonCalls: Array<{
  type: string;
  name: string;
}> = [];

let mockDeleteSecureKeyViaDaemonResult: "deleted" | "not-found" | "error" =
  "deleted";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../../inbound/platform-callback-registration.js", () => ({
  resolvePlatformCallbackRegistrationContext: async () => ({
    containerized: false,
    platformBaseUrl: "",
    assistantId: "",
    hasInternalApiKey: false,
    hasAssistantApiKey: false,
    authHeader: null,
    enabled: false,
  }),
  registerCallbackRoute: async () => "",
  shouldUsePlatformCallbacks: () => false,
}));

mock.module("../../../lib/daemon-credential-client.js", () => ({
  getSecureKeyViaDaemon: (account: string) =>
    mockGetSecureKeyViaDaemon(account),
  deleteSecureKeyViaDaemon: async (type: string, name: string) => {
    mockDeleteSecureKeyViaDaemonCalls.push({ type, name });
    return mockDeleteSecureKeyViaDaemonResult;
  },
  setSecureKeyViaDaemon: async () => false,
  getProviderKeyViaDaemon: async () => undefined,
  getSecureKeyResultViaDaemon: async () => ({
    value: undefined,
    unreachable: false,
  }),
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

const { registerPlatformCommand } = await import("../index.js");

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
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerPlatformCommand(program);
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

describe("assistant platform disconnect", () => {
  beforeEach(() => {
    mockGetSecureKeyViaDaemon = async () => undefined;
    mockDeleteSecureKeyViaDaemonCalls = [];
    mockDeleteSecureKeyViaDaemonResult = "deleted";
    process.exitCode = 0;
  });

  test("successfully removes all stored platform credentials", async () => {
    /**
     * When a connected platform has stored credentials, the disconnect
     * command should delete all credential keys and report success with
     * the previous base URL.
     */

    // GIVEN stored platform credentials exist
    mockGetSecureKeyViaDaemon = async (account: string) => {
      if (account === "credential/vellum/platform_base_url")
        return "https://platform.vellum.ai";
      if (account === "credential/vellum/assistant_api_key")
        return "sk-test-key";
      return undefined;
    };

    // AND credential deletion succeeds
    mockDeleteSecureKeyViaDaemonResult = "deleted";

    // WHEN the disconnect command is run with --json
    const { exitCode, stdout } = await runCommand([
      "platform",
      "disconnect",
      "--json",
    ]);

    // THEN the command succeeds
    expect(exitCode).toBe(0);

    // AND the output confirms disconnection with the previous base URL
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.disconnected).toBe(true);
    expect(parsed.previousBaseUrl).toBe("https://platform.vellum.ai");

    // AND all five credential keys were deleted
    expect(mockDeleteSecureKeyViaDaemonCalls).toHaveLength(5);
    const deletedNames = mockDeleteSecureKeyViaDaemonCalls.map((c) => c.name);
    expect(deletedNames).toContain("vellum:platform_base_url");
    expect(deletedNames).toContain("vellum:assistant_api_key");
    expect(deletedNames).toContain("vellum:platform_assistant_id");
    expect(deletedNames).toContain("vellum:platform_organization_id");
    expect(deletedNames).toContain("vellum:platform_user_id");
  });
});
