/**
 * Tests for the `assistant watchers` CLI command.
 *
 * Validates:
 *   - Subcommand registration (list, create, update, delete, digest)
 *   - `create` sends correct IPC method and params
 *   - `create` maps `--poll-interval` to `poll_interval_ms` param
 *   - `list` with `--id` sends `watcher_id` param
 *   - `list` with `--enabled-only` sends `enabled_only: true`
 *   - `update` maps `--disabled` flag to `enabled: false`
 *   - `delete` sends watcher ID as positional arg
 *   - `digest` defaults hours=24, limit=50
 *   - `--json` flag outputs structured JSON for each subcommand
 *   - IPC error results in exit code 1
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** The last `cliIpcCall` invocation captured for assertions. */
let lastIpcCall: {
  method: string;
  params?: Record<string, unknown>;
} | null = null;

/** The result that cliIpcCall will return. */
let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
} = { ok: true, result: [] };

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
}));

mock.module("../../../util/logger.js", () => ({
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
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerWatchersCommand } = await import("../watchers.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const stdoutChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerWatchersCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = { ok: true, result: [] };
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Subcommand registration
// ---------------------------------------------------------------------------

describe("subcommand registration", () => {
  test("registers list, create, update, delete, digest subcommands under watchers", () => {
    const program = new Command();
    registerWatchersCommand(program);
    const watchers = program.commands.find((c) => c.name() === "watchers");
    expect(watchers).toBeDefined();
    const subcommandNames = watchers!.commands.map((c) => c.name()).sort();
    expect(subcommandNames).toEqual([
      "create",
      "delete",
      "digest",
      "list",
      "update",
    ]);
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("watchers create", () => {
  test("sends correct IPC method and params", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        id: "w-1",
        name: "My Watcher",
        providerId: "linear",
        actionPrompt: "summarize",
      },
    };

    const { exitCode } = await runCommand([
      "watchers",
      "create",
      "--name",
      "My Watcher",
      "--provider",
      "linear",
      "--action-prompt",
      "summarize",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("watcher/create");
    expect(lastIpcCall!.params!.name).toBe("My Watcher");
    expect(lastIpcCall!.params!.provider).toBe("linear");
    expect(lastIpcCall!.params!.action_prompt).toBe("summarize");
  });

  test("maps --poll-interval to poll_interval_ms param", async () => {
    mockIpcResult = {
      ok: true,
      result: { id: "w-1", name: "Watcher" },
    };

    await runCommand([
      "watchers",
      "create",
      "--name",
      "Watcher",
      "--provider",
      "linear",
      "--action-prompt",
      "check",
      "--poll-interval",
      "30000",
    ]);

    expect(lastIpcCall!.params!.poll_interval_ms).toBe(30000);
  });

  test("passes --config as parsed JSON", async () => {
    mockIpcResult = {
      ok: true,
      result: { id: "w-1", name: "Watcher" },
    };

    await runCommand([
      "watchers",
      "create",
      "--name",
      "Watcher",
      "--provider",
      "github",
      "--action-prompt",
      "review",
      "--config",
      '{"repo":"org/repo"}',
    ]);

    expect(lastIpcCall!.params!.config).toEqual({ repo: "org/repo" });
  });

  test("passes --credential-service", async () => {
    mockIpcResult = {
      ok: true,
      result: { id: "w-1", name: "Watcher" },
    };

    await runCommand([
      "watchers",
      "create",
      "--name",
      "Watcher",
      "--provider",
      "linear",
      "--action-prompt",
      "check",
      "--credential-service",
      "my-service",
    ]);

    expect(lastIpcCall!.params!.credential_service).toBe("my-service");
  });

  test("--json outputs structured JSON on success", async () => {
    mockIpcResult = {
      ok: true,
      result: { id: "w-1", name: "Watcher", providerId: "linear" },
    };

    const { exitCode, stdout } = await runCommand([
      "watchers",
      "create",
      "--name",
      "Watcher",
      "--provider",
      "linear",
      "--action-prompt",
      "check",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.id).toBe("w-1");
  });

  test("errors on invalid --config JSON", async () => {
    const { exitCode } = await runCommand([
      "watchers",
      "create",
      "--name",
      "Watcher",
      "--provider",
      "linear",
      "--action-prompt",
      "check",
      "--config",
      "{invalid}",
    ]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("--json outputs error on invalid --config JSON", async () => {
    const { exitCode, stdout } = await runCommand([
      "watchers",
      "create",
      "--name",
      "Watcher",
      "--provider",
      "linear",
      "--action-prompt",
      "check",
      "--config",
      "{invalid}",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Invalid --config JSON");
  });

  test("IPC error results in exit code 1", async () => {
    mockIpcResult = {
      ok: false,
      error: 'Unknown provider "foo"',
    };

    const { exitCode } = await runCommand([
      "watchers",
      "create",
      "--name",
      "Watcher",
      "--provider",
      "foo",
      "--action-prompt",
      "check",
    ]);

    expect(exitCode).toBe(1);
  });

  test("--json outputs error on IPC failure", async () => {
    mockIpcResult = {
      ok: false,
      error: "Could not connect to assistant. Is it running?",
    };

    const { exitCode, stdout } = await runCommand([
      "watchers",
      "create",
      "--name",
      "Watcher",
      "--provider",
      "linear",
      "--action-prompt",
      "check",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Could not connect");
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("watchers list", () => {
  test("sends watcher/list IPC with no params by default", async () => {
    mockIpcResult = { ok: true, result: [] };

    const { exitCode } = await runCommand(["watchers", "list"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("watcher/list");
    expect(lastIpcCall!.params!.watcher_id).toBeUndefined();
    expect(lastIpcCall!.params!.enabled_only).toBeUndefined();
  });

  test("--id sends watcher_id param", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        watcher: {
          id: "w-1",
          name: "Test",
          providerId: "linear",
          enabled: true,
          pollIntervalMs: 60000,
          actionPrompt: "check",
        },
        events: [],
      },
    };

    await runCommand(["watchers", "list", "--id", "w-1"]);

    expect(lastIpcCall!.params!.watcher_id).toBe("w-1");
  });

  test("--enabled-only sends enabled_only: true", async () => {
    mockIpcResult = { ok: true, result: [] };

    await runCommand(["watchers", "list", "--enabled-only"]);

    expect(lastIpcCall!.params!.enabled_only).toBe(true);
  });

  test("--json outputs structured JSON", async () => {
    mockIpcResult = {
      ok: true,
      result: [{ id: "w-1", name: "Watcher", enabled: true }],
    };

    const { exitCode, stdout } = await runCommand([
      "watchers",
      "list",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBeArray();
  });

  test("IPC error results in exit code 1", async () => {
    mockIpcResult = { ok: false, error: "Connection refused" };

    const { exitCode } = await runCommand(["watchers", "list"]);

    expect(exitCode).toBe(1);
  });

  test("--json outputs error on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Connection refused" };

    const { exitCode, stdout } = await runCommand([
      "watchers",
      "list",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: false, error: "Connection refused" });
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("watchers update", () => {
  test("sends watcher_id from positional arg", async () => {
    mockIpcResult = {
      ok: true,
      result: { id: "w-1", name: "Updated" },
    };

    await runCommand(["watchers", "update", "w-1", "--name", "Updated"]);

    expect(lastIpcCall!.method).toBe("watcher/update");
    expect(lastIpcCall!.params!.watcher_id).toBe("w-1");
    expect(lastIpcCall!.params!.name).toBe("Updated");
  });

  test("maps --disabled flag to enabled: false", async () => {
    mockIpcResult = {
      ok: true,
      result: { id: "w-1", name: "Watcher", enabled: false },
    };

    await runCommand(["watchers", "update", "w-1", "--disabled"]);

    expect(lastIpcCall!.params!.enabled).toBe(false);
  });

  test("maps --enabled flag to enabled: true", async () => {
    mockIpcResult = {
      ok: true,
      result: { id: "w-1", name: "Watcher", enabled: true },
    };

    await runCommand(["watchers", "update", "w-1", "--enabled"]);

    expect(lastIpcCall!.params!.enabled).toBe(true);
  });

  test("maps --action-prompt to action_prompt", async () => {
    mockIpcResult = {
      ok: true,
      result: { id: "w-1", name: "Watcher" },
    };

    await runCommand([
      "watchers",
      "update",
      "w-1",
      "--action-prompt",
      "new prompt",
    ]);

    expect(lastIpcCall!.params!.action_prompt).toBe("new prompt");
  });

  test("maps --poll-interval to poll_interval_ms", async () => {
    mockIpcResult = {
      ok: true,
      result: { id: "w-1", name: "Watcher" },
    };

    await runCommand(["watchers", "update", "w-1", "--poll-interval", "60000"]);

    expect(lastIpcCall!.params!.poll_interval_ms).toBe(60000);
  });

  test("--json outputs structured JSON on success", async () => {
    mockIpcResult = {
      ok: true,
      result: { id: "w-1", name: "Updated" },
    };

    const { exitCode, stdout } = await runCommand([
      "watchers",
      "update",
      "w-1",
      "--name",
      "Updated",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.name).toBe("Updated");
  });

  test("IPC error results in exit code 1", async () => {
    mockIpcResult = { ok: false, error: "Watcher not found: w-bad" };

    const { exitCode } = await runCommand([
      "watchers",
      "update",
      "w-bad",
      "--name",
      "Updated",
    ]);

    expect(exitCode).toBe(1);
  });

  test("--json outputs error on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Watcher not found: w-bad" };

    const { exitCode, stdout } = await runCommand([
      "watchers",
      "update",
      "w-bad",
      "--name",
      "Updated",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Watcher not found");
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("watchers delete", () => {
  test("sends watcher ID as positional arg", async () => {
    mockIpcResult = {
      ok: true,
      result: { deleted: true, name: "My Watcher" },
    };

    const { exitCode } = await runCommand(["watchers", "delete", "w-1"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("watcher/delete");
    expect(lastIpcCall!.params).toEqual({ watcher_id: "w-1" });
  });

  test("--json outputs structured JSON on success", async () => {
    mockIpcResult = {
      ok: true,
      result: { deleted: true, name: "My Watcher" },
    };

    const { exitCode, stdout } = await runCommand([
      "watchers",
      "delete",
      "w-1",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.deleted).toBe(true);
  });

  test("IPC error results in exit code 1", async () => {
    mockIpcResult = { ok: false, error: "Watcher not found: w-bad" };

    const { exitCode } = await runCommand(["watchers", "delete", "w-bad"]);

    expect(exitCode).toBe(1);
  });

  test("--json outputs error on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Watcher not found: w-bad" };

    const { exitCode, stdout } = await runCommand([
      "watchers",
      "delete",
      "w-bad",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Watcher not found");
  });
});

// ---------------------------------------------------------------------------
// digest
// ---------------------------------------------------------------------------

describe("watchers digest", () => {
  test("sends watcher/digest with no params by default (server defaults hours=24, limit=50)", async () => {
    mockIpcResult = {
      ok: true,
      result: { events: [], watcherNames: {} },
    };

    const { exitCode } = await runCommand(["watchers", "digest"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("watcher/digest");
    // When no flags are passed, no hours/limit are sent — the server defaults apply
    expect(lastIpcCall!.params!.watcher_id).toBeUndefined();
    expect(lastIpcCall!.params!.hours).toBeUndefined();
    expect(lastIpcCall!.params!.limit).toBeUndefined();
  });

  test("passes --id as watcher_id", async () => {
    mockIpcResult = {
      ok: true,
      result: { events: [], watcherNames: {} },
    };

    await runCommand(["watchers", "digest", "--id", "w-1"]);

    expect(lastIpcCall!.params!.watcher_id).toBe("w-1");
  });

  test("passes --hours and --limit", async () => {
    mockIpcResult = {
      ok: true,
      result: { events: [], watcherNames: {} },
    };

    await runCommand(["watchers", "digest", "--hours", "48", "--limit", "100"]);

    expect(lastIpcCall!.params!.hours).toBe(48);
    expect(lastIpcCall!.params!.limit).toBe(100);
  });

  test("--json outputs structured JSON on success", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        events: [
          {
            id: "e-1",
            watcherId: "w-1",
            type: "issue_created",
            summary: "New bug",
            createdAt: 1700000000000,
          },
        ],
        watcherNames: { "w-1": "Linear Watcher" },
      },
    };

    const { exitCode, stdout } = await runCommand([
      "watchers",
      "digest",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.events).toBeArray();
    expect(parsed.data.watcherNames).toBeDefined();
  });

  test("IPC error results in exit code 1", async () => {
    mockIpcResult = { ok: false, error: "Connection refused" };

    const { exitCode } = await runCommand(["watchers", "digest"]);

    expect(exitCode).toBe(1);
  });

  test("--json outputs error on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Connection refused" };

    const { exitCode, stdout } = await runCommand([
      "watchers",
      "digest",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: false, error: "Connection refused" });
  });
});
