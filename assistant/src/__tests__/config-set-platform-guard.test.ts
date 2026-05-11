import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
//
// The `config` CLI is now an IPC-tagged command (routed via cliIpcCall) so
// these tests assert on the IPC calls the CLI emits, not on direct loader
// writes. The only non-IPC interaction is `requirePlatformConnection`, which
// reads the platform client - mocked below.
// ---------------------------------------------------------------------------

let mockPlatformClientCreate: () => Promise<Record<
  string,
  unknown
> | null> = async () => null;

const mockIpcCalls: Array<{
  method: string;
  params?: Record<string, unknown>;
}> = [];

let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
} = { ok: true, result: { ok: true } };

// ---------------------------------------------------------------------------
// Mocks - platform/client (controls requirePlatformConnection)
// ---------------------------------------------------------------------------

mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: () => mockPlatformClientCreate(),
  },
}));

// ---------------------------------------------------------------------------
// Mocks - ipc/cli-client (the CLI's only write path)
// ---------------------------------------------------------------------------

mock.module("../ipc/cli-client.js", () => ({
  cliIpcCall: async (
    method: string,
    params?: Record<string, unknown>,
  ) => {
    mockIpcCalls.push({ method, params });
    return mockIpcResult;
  },
  exitFromIpcResult: (r: {
    error?: string;
    statusCode?: number;
  }) => {
    process.stderr.write((r.error ?? "Unknown error") + "\n");
    if (r.statusCode === undefined) {
      process.exitCode = 10;
    } else if (r.statusCode >= 500) {
      process.exitCode = 3;
    } else if (r.statusCode >= 400) {
      process.exitCode = 2;
    } else {
      process.exitCode = 1;
    }
    throw new Error(`exitFromIpcResult(${r.statusCode ?? "no-status"})`);
  },
}));

// ---------------------------------------------------------------------------
// Mocks - util/logger (suppress log output)
// ---------------------------------------------------------------------------

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
// Mocks - oauth/oauth-store (transitive dep guard for oauth/shared.ts)
// ---------------------------------------------------------------------------

mock.module("../oauth/oauth-store.js", () => ({
  disconnectOAuthProvider: async () => "not-found" as const,
  getConnection: () => undefined,
  getConnectionByProvider: () => undefined,
  listConnections: () => [],
  deleteConnection: () => false,
  upsertApp: async () => ({}),
  getApp: () => undefined,
  getAppByProviderAndClientId: () => undefined,
  getMostRecentAppByProvider: () => undefined,
  listApps: () => [],
  deleteApp: async () => false,
  getProvider: () => undefined,
  listProviders: () => [],
  registerProvider: () => ({}),
  updateProvider: () => undefined,
  deleteProvider: () => false,
  seedProviders: () => {},
  getActiveConnection: () => undefined,
  listActiveConnectionsByProvider: () => [],
  createConnection: () => ({}),
  isProviderConnected: () => false,
  updateConnection: () => ({}),
}));

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are registered)
// ---------------------------------------------------------------------------

const { registerConfigCommand } = await import("../cli/commands/config.js");

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
    program.option("--json", "JSON output");
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerConfigCommand(program);
    await program.parseAsync(args);
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

describe("config set - platform connection guard for service mode paths", () => {
  beforeEach(() => {
    // Default: not connected to platform
    mockPlatformClientCreate = async () => null;
    mockIpcCalls.length = 0;
    mockIpcResult = { ok: true, result: { ok: true } };
  });

  test("config set services.image-generation.mode your-own - succeeds without platform connection", async () => {
    const { exitCode } = await runCli([
      "node",
      "assistant",
      "--json",
      "config",
      "set",
      "services.image-generation.mode",
      "your-own",
    ]);

    expect(exitCode).toBe(0);
    // The CLI should have emitted exactly one config_set IPC call.
    const setCalls = mockIpcCalls.filter((c) => c.method === "config_set");
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]!.params).toEqual({
      body: {
        path: "services.image-generation.mode",
        value: "your-own",
      },
    });
  });

  test("config set calls.enabled true - succeeds without platform connection and parses to boolean", async () => {
    const { exitCode } = await runCli([
      "node",
      "assistant",
      "config",
      "set",
      "calls.enabled",
      "true",
    ]);

    expect(exitCode).toBe(0);
    const setCalls = mockIpcCalls.filter((c) => c.method === "config_set");
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]!.params).toEqual({
      body: { path: "calls.enabled", value: true },
    });
  });

  test("config set ingress.publicBaseUrl - sends the new value to the daemon", async () => {
    // Daemon-side semantics (sibling preservation, deep-merge avoidance) are
    // covered by daemon route tests. Here we only verify the CLI sends the
    // correct dotted-path + value pair via IPC.
    const { exitCode } = await runCli([
      "node",
      "assistant",
      "config",
      "set",
      "ingress.publicBaseUrl",
      "https://manual.example.test",
    ]);

    expect(exitCode).toBe(0);
    const setCalls = mockIpcCalls.filter((c) => c.method === "config_set");
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]!.params).toEqual({
      body: {
        path: "ingress.publicBaseUrl",
        value: "https://manual.example.test",
      },
    });
  });

  test("config set services.web-search.mode managed - fails when not connected, no IPC write emitted", async () => {
    const { exitCode, stdout } = await runCli([
      "node",
      "assistant",
      "--json",
      "config",
      "set",
      "services.web-search.mode",
      "managed",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("vellum platform connect");
    // The guard runs *before* the IPC call - no config_set should have been
    // emitted.
    expect(
      mockIpcCalls.filter((c) => c.method === "config_set"),
    ).toHaveLength(0);
  });
});
