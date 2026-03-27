import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockGetProvider: (
  key: string,
) => Record<string, unknown> | undefined = () => undefined;

let mockResolveOAuthConnectionResult:
  | { request: (req: unknown) => Promise<unknown> }
  | Error = new Error("not configured");

let mockResolveOAuthConnectionCalls: Array<{
  providerKey: string;
  options?: Record<string, unknown>;
}> = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => ({ services: {} }),
  API_KEY_PROVIDERS: [],
}));

mock.module("../../../../oauth/oauth-store.js", () => ({
  getProvider: (key: string) => mockGetProvider(key),
  getConnection: () => undefined,
  getConnectionByProvider: () => undefined,
  getActiveConnection: () => undefined,
  listActiveConnectionsByProvider: () => [],
  listConnections: () => [],
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

mock.module("../../../../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: async (
    providerKey: string,
    options?: Record<string, unknown>,
  ) => {
    mockResolveOAuthConnectionCalls.push({ providerKey, options });
    if (mockResolveOAuthConnectionResult instanceof Error) {
      throw mockResolveOAuthConnectionResult;
    }
    return mockResolveOAuthConnectionResult;
  },
}));

mock.module("../../../../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => null,
  },
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

// Mock shared.js helpers
mock.module("../shared.js", () => ({
  isManagedMode: () => false,
  requirePlatformClient: async () => null,
  fetchActiveConnections: async () => [],
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks are registered)
// ---------------------------------------------------------------------------

const { registerPingCommand } = await import("../ping.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.option("--json", "JSON output");
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerPingCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
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
    stderr: stderrChunks.join(""),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant oauth ping", () => {
  beforeEach(() => {
    mockGetProvider = () => undefined;
    mockResolveOAuthConnectionResult = new Error("not configured");
    mockResolveOAuthConnectionCalls = [];
    process.exitCode = 0;
  });

  // -------------------------------------------------------------------------
  // Provider not found
  // -------------------------------------------------------------------------

  test("unknown provider returns error", async () => {
    mockGetProvider = () => undefined;

    const { exitCode, stdout } = await runCommand([
      "ping",
      "nonexistent",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Unknown provider");
    expect(parsed.error).toContain("providers list");
  });

  // -------------------------------------------------------------------------
  // No ping URL configured
  // -------------------------------------------------------------------------

  test("no ping URL configured returns error", async () => {
    mockGetProvider = () => ({
      providerKey: "google",
      pingUrl: null,
    });

    const { exitCode, stdout } = await runCommand(["ping", "google", "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No ping URL configured");
    expect(parsed.error).toContain("providers register --ping-url");
  });

  // =========================================================================
  // BYO mode tests
  // =========================================================================

  describe("BYO mode", () => {
    beforeEach(() => {
      mockGetProvider = () => ({
        providerKey: "google",
        pingUrl: "https://www.googleapis.com/oauth2/v1/tokeninfo",
        managedServiceConfigKey: null,
      });
    });

    test("successful ping (2xx response)", async () => {
      mockResolveOAuthConnectionResult = {
        request: async () => ({
          status: 200,
          headers: { "content-type": "application/json" },
          body: { email: "user@gmail.com" },
        }),
      };

      const { exitCode, stdout } = await runCommand([
        "ping",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.provider).toBe("google");
      expect(parsed.status).toBe(200);
    });

    test("failed ping (non-2xx response)", async () => {
      mockResolveOAuthConnectionResult = {
        request: async () => ({
          status: 500,
          headers: {},
          body: { error: "Internal server error" },
        }),
      };

      const { exitCode, stdout } = await runCommand([
        "ping",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.provider).toBe("google");
      expect(parsed.status).toBe(500);
      expect(parsed.error).toContain("Ping failed with HTTP 500");
    });

    test("401 response includes auth hint", async () => {
      mockResolveOAuthConnectionResult = {
        request: async () => ({
          status: 401,
          headers: {},
          body: { error: "Unauthorized" },
        }),
      };

      const { exitCode, stdout } = await runCommand([
        "ping",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.status).toBe(401);
      expect(parsed.error).toContain("Ping failed with HTTP 401");
      expect(parsed.hint).toContain("oauth status");
      expect(parsed.hint).toContain("oauth connect");
    });

    test("403 response includes auth hint", async () => {
      mockResolveOAuthConnectionResult = {
        request: async () => ({
          status: 403,
          headers: {},
          body: { error: "Forbidden" },
        }),
      };

      const { exitCode, stdout } = await runCommand([
        "ping",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.status).toBe(403);
      expect(parsed.hint).toContain("oauth status");
      expect(parsed.hint).toContain("oauth connect");
    });
  });

  // =========================================================================
  // Managed mode tests
  // =========================================================================

  describe("managed mode", () => {
    beforeEach(() => {
      mockGetProvider = () => ({
        providerKey: "google",
        pingUrl: "https://www.googleapis.com/oauth2/v1/tokeninfo",
        managedServiceConfigKey: "google-oauth",
      });
    });

    test("successful ping through platform connection", async () => {
      mockResolveOAuthConnectionResult = {
        request: async () => ({
          status: 200,
          headers: { "content-type": "application/json" },
          body: { email: "managed@gmail.com" },
        }),
      };

      const { exitCode, stdout } = await runCommand([
        "ping",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.provider).toBe("google");
      expect(parsed.status).toBe(200);
    });

    test("failed ping through platform connection", async () => {
      mockResolveOAuthConnectionResult = {
        request: async () => ({
          status: 502,
          headers: {},
          body: { error: "Bad Gateway" },
        }),
      };

      const { exitCode, stdout } = await runCommand([
        "ping",
        "google",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.provider).toBe("google");
      expect(parsed.status).toBe(502);
      expect(parsed.error).toContain("Ping failed with HTTP 502");
    });
  });

  // =========================================================================
  // Connection resolution failure
  // =========================================================================

  test("connection resolution failure (no active connection) with recovery hint", async () => {
    mockGetProvider = () => ({
      providerKey: "google",
      pingUrl: "https://www.googleapis.com/oauth2/v1/tokeninfo",
    });

    mockResolveOAuthConnectionResult = new Error(
      'No active OAuth connection found for "google". Connect the service first with `assistant oauth connect google`.',
    );

    const { exitCode, stdout } = await runCommand(["ping", "google", "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No active OAuth connection");
    expect(parsed.hint).toContain("oauth status");
    expect(parsed.hint).toContain("oauth connect");
  });

  // =========================================================================
  // --account option
  // =========================================================================

  test("--account option passed through to connection resolution", async () => {
    mockGetProvider = () => ({
      providerKey: "google",
      pingUrl: "https://www.googleapis.com/oauth2/v1/tokeninfo",
    });

    mockResolveOAuthConnectionResult = {
      request: async () => ({
        status: 200,
        headers: {},
        body: {},
      }),
    };

    const { exitCode } = await runCommand([
      "ping",
      "google",
      "--account",
      "user@example.com",
      "--json",
    ]);
    expect(exitCode).toBe(0);

    expect(mockResolveOAuthConnectionCalls).toHaveLength(1);
    expect(mockResolveOAuthConnectionCalls[0].options).toEqual({
      account: "user@example.com",
    });
  });

  // =========================================================================
  // --client-id option
  // =========================================================================

  test("--client-id option passed through to connection resolution", async () => {
    mockGetProvider = () => ({
      providerKey: "google",
      pingUrl: "https://www.googleapis.com/oauth2/v1/tokeninfo",
    });

    mockResolveOAuthConnectionResult = {
      request: async () => ({
        status: 200,
        headers: {},
        body: {},
      }),
    };

    const { exitCode } = await runCommand([
      "ping",
      "google",
      "--client-id",
      "my-client-id",
      "--json",
    ]);
    expect(exitCode).toBe(0);

    expect(mockResolveOAuthConnectionCalls).toHaveLength(1);
    expect(mockResolveOAuthConnectionCalls[0].options).toEqual({
      clientId: "my-client-id",
    });
  });

  // =========================================================================
  // JSON output mode
  // =========================================================================

  test("JSON output mode returns structured response", async () => {
    mockGetProvider = () => ({
      providerKey: "google",
      pingUrl: "https://www.googleapis.com/oauth2/v1/tokeninfo",
    });

    mockResolveOAuthConnectionResult = {
      request: async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: { email: "user@gmail.com" },
      }),
    };

    const { exitCode, stdout } = await runCommand(["ping", "google", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);

    // Verify JSON structure
    expect(parsed).toHaveProperty("ok", true);
    expect(parsed).toHaveProperty("provider", "google");
    expect(parsed).toHaveProperty("status", 200);
  });

  // =========================================================================
  // Human output mode
  // =========================================================================

  test("human output mode logs to stderr on success", async () => {
    mockGetProvider = () => ({
      providerKey: "google",
      pingUrl: "https://www.googleapis.com/oauth2/v1/tokeninfo",
    });

    mockResolveOAuthConnectionResult = {
      request: async () => ({
        status: 200,
        headers: {},
        body: {},
      }),
    };

    // Run without --json — human output path logs via getCliLogger (which is mocked)
    const { exitCode, stdout } = await runCommand(["ping", "google"]);
    expect(exitCode).toBe(0);

    // In human mode, output is still written via writeOutput
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.provider).toBe("google");
  });

  // =========================================================================
  // Provider ping config (method / headers / body)
  // =========================================================================

  test("uses configured pingMethod for POST providers", async () => {
    mockGetProvider = () => ({
      providerKey: "dropbox",
      pingUrl: "https://api.dropboxapi.com/2/users/get_current_account",
      pingMethod: "POST",
      pingHeaders: null,
      pingBody: null,
    });

    let capturedRequestArgs: Record<string, unknown> = {};
    mockResolveOAuthConnectionResult = {
      request: async (req: unknown) => {
        capturedRequestArgs = req as Record<string, unknown>;
        return { status: 200, headers: {}, body: {} };
      },
    };

    const { exitCode } = await runCommand(["ping", "dropbox", "--json"]);
    expect(exitCode).toBe(0);
    expect(capturedRequestArgs.method).toBe("POST");
  });

  test("uses configured pingHeaders", async () => {
    mockGetProvider = () => ({
      providerKey: "notion",
      pingUrl: "https://api.notion.com/v1/users/me",
      pingMethod: null,
      pingHeaders: '{"Notion-Version":"2022-06-28"}',
      pingBody: null,
    });

    let capturedRequestArgs: Record<string, unknown> = {};
    mockResolveOAuthConnectionResult = {
      request: async (req: unknown) => {
        capturedRequestArgs = req as Record<string, unknown>;
        return { status: 200, headers: {}, body: {} };
      },
    };

    const { exitCode } = await runCommand(["ping", "notion", "--json"]);
    expect(exitCode).toBe(0);
    expect(capturedRequestArgs.headers).toEqual({
      "Notion-Version": "2022-06-28",
    });
  });

  test("uses configured pingBody for GraphQL providers", async () => {
    mockGetProvider = () => ({
      providerKey: "linear",
      pingUrl: "https://api.linear.app/graphql",
      pingMethod: "POST",
      pingHeaders: '{"Content-Type":"application/json"}',
      pingBody: '{"query":"{ viewer { id name email } }"}',
    });

    let capturedRequestArgs: Record<string, unknown> = {};
    mockResolveOAuthConnectionResult = {
      request: async (req: unknown) => {
        capturedRequestArgs = req as Record<string, unknown>;
        return { status: 200, headers: {}, body: {} };
      },
    };

    const { exitCode } = await runCommand(["ping", "linear", "--json"]);
    expect(exitCode).toBe(0);
    expect(capturedRequestArgs.method).toBe("POST");
    expect(capturedRequestArgs.headers).toEqual({
      "Content-Type": "application/json",
    });
    expect(capturedRequestArgs.body).toEqual({
      query: "{ viewer { id name email } }",
    });
  });

  test("defaults to GET with no extra headers/body when ping config is null", async () => {
    mockGetProvider = () => ({
      providerKey: "google",
      pingUrl: "https://www.googleapis.com/oauth2/v1/tokeninfo",
      pingMethod: null,
      pingHeaders: null,
      pingBody: null,
    });

    let capturedRequestArgs: Record<string, unknown> = {};
    mockResolveOAuthConnectionResult = {
      request: async (req: unknown) => {
        capturedRequestArgs = req as Record<string, unknown>;
        return { status: 200, headers: {}, body: {} };
      },
    };

    const { exitCode } = await runCommand(["ping", "google", "--json"]);
    expect(exitCode).toBe(0);
    expect(capturedRequestArgs.method).toBe("GET");
    expect(capturedRequestArgs.headers).toBeUndefined();
    expect(capturedRequestArgs.body).toBeUndefined();
  });

  // =========================================================================
  // Network failure
  // =========================================================================

  test("network failure returns error with recovery hint", async () => {
    mockGetProvider = () => ({
      providerKey: "google",
      pingUrl: "https://www.googleapis.com/oauth2/v1/tokeninfo",
    });

    mockResolveOAuthConnectionResult = {
      request: async () => {
        throw new Error("fetch failed: ECONNREFUSED");
      },
    };

    const { exitCode, stdout } = await runCommand(["ping", "google", "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("ECONNREFUSED");
    expect(parsed.hint).toContain("oauth status");
    expect(parsed.hint).toContain("oauth connect");
  });
});
