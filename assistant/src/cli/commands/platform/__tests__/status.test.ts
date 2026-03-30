import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockGetSecureKeyViaDaemon: (
  account: string,
) => Promise<string | undefined> = async () => undefined;

let mockResolvePlatformCallbackRegistrationContext: () => Promise<
  Record<string, unknown>
> = async () => ({
  containerized: false,
  platformBaseUrl: "",
  assistantId: "",
  hasInternalApiKey: false,
  hasAssistantApiKey: false,
  authHeader: null,
  enabled: false,
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../../inbound/platform-callback-registration.js", () => ({
  resolvePlatformCallbackRegistrationContext: () =>
    mockResolvePlatformCallbackRegistrationContext(),
  registerCallbackRoute: async () => "",
  shouldUsePlatformCallbacks: () => false,
  resolveCallbackUrl: async () => "",
}));

mock.module("../../../lib/daemon-credential-client.js", () => ({
  getSecureKeyViaDaemon: (account: string) =>
    mockGetSecureKeyViaDaemon(account),
  deleteSecureKeyViaDaemon: async () => "not-found" as const,
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
    const program = buildCliProgram();
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

describe("assistant platform status", () => {
  beforeEach(() => {
    mockGetSecureKeyViaDaemon = async () => undefined;
    mockResolvePlatformCallbackRegistrationContext = async () => ({
      containerized: false,
      platformBaseUrl: "",
      assistantId: "",
      hasInternalApiKey: false,
      hasAssistantApiKey: false,
      authHeader: null,
      enabled: false,
    });
    process.exitCode = 0;
  });

  test("connected platform returns full status with stored credentials", async () => {
    /**
     * When the assistant has stored platform credentials and a valid
     * registration context, the status command should report connected
     * with all context fields populated.
     */

    // GIVEN a containerized environment with platform configuration
    mockResolvePlatformCallbackRegistrationContext = async () => ({
      containerized: true,
      platformBaseUrl: "https://platform.vellum.ai",
      assistantId: "asst-abc-123",
      hasInternalApiKey: true,
      hasAssistantApiKey: true,
      authHeader: "Bearer internal-key",
      enabled: true,
    });

    // AND stored platform credentials exist
    mockGetSecureKeyViaDaemon = async (account: string) => {
      if (account === "credential/vellum/platform_base_url")
        return "https://platform.vellum.ai";
      if (account === "credential/vellum/assistant_api_key")
        return "sk-test-key";
      if (account === "credential/vellum/platform_organization_id")
        return "org-456";
      if (account === "credential/vellum/platform_user_id") return "user-789";
      return undefined;
    };

    // WHEN the status command is run with --json
    const { exitCode, stdout } = await runCommand([
      "platform",
      "status",
      "--json",
    ]);

    // THEN the command succeeds
    expect(exitCode).toBe(0);

    // AND the output contains the expected status fields
    const parsed = JSON.parse(stdout);
    expect(parsed.containerized).toBe(true);
    expect(parsed.baseUrl).toBe("https://platform.vellum.ai");
    expect(parsed.assistantId).toBe("asst-abc-123");
    expect(parsed.hasInternalApiKey).toBe(true);
    expect(parsed.hasAssistantApiKey).toBe(true);
    expect(parsed.available).toBe(true);
    expect(parsed.connected).toBe(true);
    expect(parsed.organizationId).toBe("org-456");
    expect(parsed.userId).toBe("user-789");
  });

  test("plain text mode does not emit JSON to stdout", async () => {
    /**
     * Without --json, the status command should only produce log output
     * (via the CLI logger) and NOT write JSON to stdout. Previously both
     * JSON and plain text were emitted, duplicating the information.
     */

    // GIVEN a disconnected environment with no stored credentials
    mockResolvePlatformCallbackRegistrationContext = async () => ({
      containerized: false,
      platformBaseUrl: "",
      assistantId: "",
      hasInternalApiKey: false,
      hasAssistantApiKey: false,
      authHeader: null,
      enabled: false,
    });

    // WHEN the status command is run without --json
    const { exitCode, stdout } = await runCommand(["platform", "status"]);

    // THEN the command succeeds
    expect(exitCode).toBe(0);

    // AND stdout contains no JSON (writeOutput is skipped in plain text mode)
    expect(stdout.trim()).toBe("");
  });
});
