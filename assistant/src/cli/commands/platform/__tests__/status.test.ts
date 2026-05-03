import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockGetSecureKeyAsync: (
  account: string,
) => Promise<string | undefined> = async () => undefined;

let mockResolvePlatformCallbackRegistrationContext: () => Promise<
  Record<string, unknown>
> = async () => ({
  isPlatform: false,
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
  resolveCallbackUrl: async () => "",
}));

mock.module("../../../../security/secure-keys.js", () => ({
  getSecureKeyAsync: (account: string) => mockGetSecureKeyAsync(account),
  getSecureKeyResultAsync: async () => ({
    value: undefined,
    unreachable: false,
  }),
  setSecureKeyAsync: async () => true,
  deleteSecureKeyAsync: async () => "deleted" as const,
  getProviderKeyAsync: async () => undefined,
  getMaskedProviderKey: async () => undefined,
  bulkSetSecureKeysAsync: async () => {},
  listSecureKeysAsync: async () => ({ credentials: [] }),
  setCesClient: () => {},
  onCesClientChanged: () => ({ unsubscribe: () => {} }),
  setCesReconnect: () => {},
  getActiveBackendName: () => "file",
  _resetBackend: () => {},
}));

mock.module("../../../lib/daemon-credential-client.js", () => ({
  deleteSecureKeyViaDaemon: async () => "not-found" as const,
  setSecureKeyViaDaemon: async () => false,
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
  LOG_FILE_PATTERN: /^assistant-(\d{4}-\d{2}-\d{2})\.log$/,
}));

// Also mock the CLI logger singleton so log.info calls do not write to stdout.

mock.module("../../../../config/loader.js", () => ({
  API_KEY_PROVIDERS: [] as const,
  getConfig: () => ({
    permissions: { mode: "workspace" },
    skills: { load: { extraDirs: [] } },
    sandbox: { enabled: true },
  }),
  getConfigReadOnly: () => ({
    permissions: { mode: "workspace" },
    skills: { load: { extraDirs: [] } },
    sandbox: { enabled: true },
  }),
  loadConfig: () => ({}),
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
  applyNestedDefaults: (config: unknown) => config,
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

describe("assistant platform status", () => {
  beforeEach(() => {
    mockGetSecureKeyAsync = async () => undefined;
    mockResolvePlatformCallbackRegistrationContext = async () => ({
      isPlatform: false,
      platformBaseUrl: "",
      assistantId: "",
      hasInternalApiKey: false,
      hasAssistantApiKey: false,
      authHeader: null,
      enabled: false,
    });
    process.exitCode = 0;
  });

  test("platform pod returns full status from context", async () => {
    /**
     * When the assistant is running as a platform-managed pod, the status
     * command reports all fields from the registration context plus
     * organizationId and userId from the keychain. The connected field
     * is absent — platform status does not expose it.
     */

    // GIVEN a containerized platform environment
    mockResolvePlatformCallbackRegistrationContext = async () => ({
      isPlatform: true,
      platformBaseUrl: "https://platform.vellum.ai",
      assistantId: "asst-abc-123",
      hasInternalApiKey: true,
      hasAssistantApiKey: true,
      authHeader: "Bearer internal-key",
      enabled: true,
    });

    // AND credentials are stored in the keychain
    mockGetSecureKeyAsync = async (account: string) => {
      if (account === "credential/vellum/webhook_secret") return "wh-secret";
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
    expect(parsed.isPlatform).toBe(true);
    expect(parsed.baseUrl).toBe("https://platform.vellum.ai");
    expect(parsed.assistantId).toBe("asst-abc-123");
    expect(parsed.hasInternalApiKey).toBe(true);
    expect(parsed.hasAssistantApiKey).toBe(true);
    expect(parsed.hasWebhookSecret).toBe(true);
    expect(parsed.available).toBe(true);
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
      isPlatform: false,
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

    // Plain-text mode logs via log.info — verify writeOutput (JSON) was NOT called
    expect(() => JSON.parse(stdout.trim())).toThrow();
  });
});
