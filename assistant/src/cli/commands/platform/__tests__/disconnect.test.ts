import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = process.env.VELLUM_WORKSPACE_DIR!;

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

let mockIsPlatformRemote = false;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../../config/env-registry.js", () => ({
  getIsContainerized: () => false,
  isPlatformRemote: () => mockIsPlatformRemote,
  getDebugStdoutLogs: () => false,
  getWorkspaceDirOverride: () => undefined,
  checkUnrecognizedEnvVars: () => [],
}));

mock.module("../../../../inbound/platform-callback-registration.js", () => ({
  resolvePlatformCallbackRegistrationContext: async () => ({
    isPlatform: false,
    platformBaseUrl: "",
    assistantId: "",
    hasInternalApiKey: false,
    hasAssistantApiKey: false,
    authHeader: null,
    enabled: false,
  }),
  registerCallbackRoute: async () => "",
  shouldUsePlatformCallbacks: () => false,
  resolveCallbackUrl: async () => "",
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
  initLogger: () => {},
  truncateForLog: (value: string, maxLen = 500) =>
    value.length > maxLen ? value.slice(0, maxLen) + "..." : value,
  pruneOldLogFiles: () => 0,
}));

mock.module("../../../../config/loader.js", () => ({
  API_KEY_PROVIDERS: [] as const,
  getConfig: () => ({
    permissions: { mode: "workspace" },
    skills: { load: { extraDirs: [] } },
    sandbox: { enabled: true },
  }),
  loadConfig: () => ({}),
  invalidateConfigCache: () => {},
  saveConfig: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
  applyNestedDefaults: (config: unknown) => config,
  deepMergeMissing: () => false,
  deepMergeOverwrite: () => {},
  mergeDefaultWorkspaceConfig: () => {},
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks are registered)
// ---------------------------------------------------------------------------

const { buildCliProgram } = await import("../../../program.js");

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
    const program = await buildCliProgram();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
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
    mockIsPlatformRemote = false;
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

    // AND a platform_disconnected signal was emitted for connected clients
    const signalPath = join(testDir, "signals", "emit-event");
    expect(existsSync(signalPath)).toBe(true);
    const signal = JSON.parse(readFileSync(signalPath, "utf-8"));
    expect(signal).toEqual({ type: "platform_disconnected" });
  });

  test("rejects with error when running on a platform-hosted assistant", async () => {
    /**
     * Platform-hosted (containerized) assistants are managed by the platform
     * and should not allow manual disconnect via the CLI.
     */

    // GIVEN the assistant is running inside a platform host
    mockIsPlatformRemote = true;

    // WHEN the disconnect command is run with --json
    const { exitCode, stdout } = await runCommand([
      "platform",
      "disconnect",
      "--json",
    ]);

    // THEN the command fails
    expect(exitCode).toBe(1);

    // AND the error message explains why
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("platform-hosted");

    // AND no credentials were deleted
    expect(mockDeleteSecureKeyViaDaemonCalls).toHaveLength(0);
  });
});
