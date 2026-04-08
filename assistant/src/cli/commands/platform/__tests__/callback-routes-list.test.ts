import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

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
  shouldUsePlatformCallbacks: () => false,
  resolveCallbackUrl: async () => "",
}));

mock.module("../../../lib/daemon-credential-client.js", () => ({
  getSecureKeyViaDaemon: async () => undefined,
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
// Fetch mock
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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
// Helpers
// ---------------------------------------------------------------------------

function connectedContext(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    isPlatform: false,
    platformBaseUrl: "https://dev-platform.vellum.ai",
    assistantId: "019d6d4f-6dbd-779f-91d3-cb273b9429a5",
    hasInternalApiKey: false,
    hasAssistantApiKey: true,
    authHeader: "Api-Key vak_test123",
    enabled: false,
    ...overrides,
  };
}

function mockFetchJson(body: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant platform callback-routes list", () => {
  beforeEach(() => {
    mockResolvePlatformCallbackRegistrationContext = async () =>
      connectedContext();
    process.exitCode = 0;
  });

  test("returns empty list when no routes registered", async () => {
    mockFetchJson([]);

    const { exitCode, stdout } = await runCommand([
      "platform",
      "callback-routes",
      "list",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.routes).toEqual([]);
  });

  test("returns registered routes", async () => {
    const routes = [
      {
        id: "route-1",
        assistant_id: "019d6d4f-6dbd-779f-91d3-cb273b9429a5",
        type: "email",
        callback_path: "019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/email",
        callback_url:
          "https://dev-platform.vellum.ai/v1/gateway/callbacks/019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/email/",
      },
      {
        id: "route-2",
        assistant_id: "019d6d4f-6dbd-779f-91d3-cb273b9429a5",
        type: "telegram",
        callback_path: "019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/telegram",
        callback_url:
          "https://dev-platform.vellum.ai/v1/gateway/callbacks/019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/telegram/",
      },
    ];
    mockFetchJson(routes);

    const { exitCode, stdout } = await runCommand([
      "platform",
      "callback-routes",
      "list",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.routes).toHaveLength(2);
    expect(parsed.routes[0].type).toBe("email");
    expect(parsed.routes[1].type).toBe("telegram");
  });

  test("fails when platform credentials are missing", async () => {
    mockResolvePlatformCallbackRegistrationContext = async () => ({
      isPlatform: false,
      platformBaseUrl: "",
      assistantId: "",
      hasInternalApiKey: false,
      hasAssistantApiKey: false,
      authHeader: null,
      enabled: false,
    });

    const { exitCode, stdout } = await runCommand([
      "platform",
      "callback-routes",
      "list",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Platform credentials not available");
  });

  test("handles platform HTTP error", async () => {
    mockFetchJson({ detail: "Unauthorized" }, 401);

    const { exitCode, stdout } = await runCommand([
      "platform",
      "callback-routes",
      "list",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("HTTP 401");
  });

  test("works for self-hosted assistants with connected credentials", async () => {
    // IS_PLATFORM is false but we have stored credentials — enabled is false
    // but platformBaseUrl and authHeader are set
    mockResolvePlatformCallbackRegistrationContext = async () =>
      connectedContext({ isPlatform: false, enabled: false });

    mockFetchJson([
      {
        id: "route-1",
        assistant_id: "019d6d4f-6dbd-779f-91d3-cb273b9429a5",
        type: "email",
        callback_path: "019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/email",
        callback_url:
          "https://dev-platform.vellum.ai/v1/gateway/callbacks/019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/email/",
      },
    ]);

    const { exitCode, stdout } = await runCommand([
      "platform",
      "callback-routes",
      "list",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.routes).toHaveLength(1);
  });
});
