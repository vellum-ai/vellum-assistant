import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = process.env.VELLUM_WORKSPACE_DIR!;

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockGetSecureKeyAsync: (
  account: string,
) => Promise<string | undefined> = async () => undefined;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
  setSecureKeyViaDaemon: async () => true,
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
  resolveCallbackUrl: async () => "",
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

describe("assistant platform connect", () => {
  beforeEach(() => {
    mockGetSecureKeyAsync = async () => undefined;
    process.exitCode = 0;
    // Remove any signal file left by previous tests
    try {
      rmSync(join(testDir, "signals"), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("writes emit-event signal file and reports success", async () => {
    // GIVEN no existing platform credentials
    mockGetSecureKeyAsync = async () => undefined;

    // WHEN the connect command is run with --json
    const { exitCode, stdout } = await runCommand([
      "platform",
      "connect",
      "--json",
    ]);

    // THEN the command succeeds
    expect(exitCode).toBe(0);

    // AND the output confirms the login UI was triggered
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.showPlatformLogin).toBe(true);

    // AND a show_platform_login emit-event signal file was written
    const signalPath = join(testDir, "signals", "emit-event");
    expect(existsSync(signalPath)).toBe(true);
    const payload = JSON.parse(readFileSync(signalPath, "utf-8"));
    expect(payload).toEqual({ type: "show_platform_login" });
  });

  test("already connected returns success with existing base URL", async () => {
    // GIVEN stored platform credentials already exist
    mockGetSecureKeyAsync = async (account: string) => {
      if (account === "credential/vellum/platform_base_url")
        return "https://platform.vellum.ai";
      if (account === "credential/vellum/assistant_api_key")
        return "sk-existing-key";
      return undefined;
    };

    // WHEN the connect command is run with --json
    const { exitCode, stdout } = await runCommand([
      "platform",
      "connect",
      "--json",
    ]);

    // THEN the command succeeds
    expect(exitCode).toBe(0);

    // AND the output indicates already connected with the base URL
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.alreadyConnected).toBe(true);
    expect(parsed.baseUrl).toBe("https://platform.vellum.ai");

    // AND no emit-event signal file was written
    const signalPath = join(testDir, "signals", "emit-event");
    expect(existsSync(signalPath)).toBe(false);
  });
});
