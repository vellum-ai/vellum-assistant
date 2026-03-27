import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "platform-connect-test-"));

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockGetSecureKeyViaDaemon: (
  account: string,
) => Promise<string | undefined> = async () => undefined;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
}));

mock.module("../../../../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => join(testDir, "data"),
  getWorkspaceSkillsDir: () => join(testDir, "skills"),
  getWorkspaceDir: () => join(testDir, "workspace"),
  getWorkspaceHooksDir: () => join(testDir, "workspace", "hooks"),
  getWorkspaceConfigPath: () => join(testDir, "workspace", "config.json"),
  getHooksDir: () => join(testDir, "hooks"),
  getSignalsDir: () => join(testDir, "signals"),
  getConversationsDir: () => join(testDir, "conversations"),
  getEmbeddingModelsDir: () => join(testDir, "models"),
  getSandboxRootDir: () => join(testDir, "sandbox"),
  getSandboxWorkingDir: () => join(testDir, "sandbox", "work"),
  getInterfacesDir: () => join(testDir, "interfaces"),
  getSoundsDir: () => join(testDir, "sounds"),
  getHistoryPath: () => join(testDir, "history"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPlatformName: () => "linux",
  getClipboardCommand: () => null,
  resolveInstanceDataDir: () => undefined,
  normalizeAssistantId: (id: string) => id,
  getTCPPort: () => 0,
  isTCPEnabled: () => false,
  getTCPHost: () => "127.0.0.1",
  isIOSPairingEnabled: () => false,
  getPlatformTokenPath: () => join(testDir, "token"),
  readPlatformToken: () => null,
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  getWorkspaceDirDisplay: () => testDir,
  getWorkspacePromptPath: (file: string) => join(testDir, file),
  ensureDataDir: () => {},
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

describe("assistant platform connect", () => {
  beforeEach(() => {
    mockGetSecureKeyViaDaemon = async () => undefined;
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
    mockGetSecureKeyViaDaemon = async () => undefined;

    // WHEN the connect command is run with --json
    const { exitCode, stdout } = await runCommand([
      "platform",
      "connect",
      "--json",
    ]);

    // THEN the command succeeds
    expect(exitCode).toBe(0);

    // AND the output confirms navigation
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.navigatedToSettings).toBe(true);

    // AND a generic emit-event signal file was written for the daemon
    const signalPath = join(testDir, "signals", "emit-event");
    expect(existsSync(signalPath)).toBe(true);
    const payload = JSON.parse(readFileSync(signalPath, "utf-8"));
    expect(payload).toEqual({ type: "navigate_settings", tab: "General" });
  });

  test("already connected returns success with existing base URL", async () => {
    // GIVEN stored platform credentials already exist
    mockGetSecureKeyViaDaemon = async (account: string) => {
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
