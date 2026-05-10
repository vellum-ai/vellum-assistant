/**
 * Tests for the `assistant backup` CLI command tree.
 *
 * Uses the IPC mock pattern: cliIpcCall is stubbed out so tests assert the
 * correct method + params are sent without touching the daemon or filesystem.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** The last `cliIpcCall` invocation captured for assertions. */
let lastIpcCall: { method: string; params?: any } | null = null;

/** The result that cliIpcCall will return. */
let mockIpcResult: { ok: boolean; result?: unknown; error?: string } = {
  ok: true,
  result: {},
};

/** Captured log output for assertion. */
let logOutput: string[] = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: any) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
  exitFromIpcResult: (r: any) => {
    process.exitCode = 1;
    throw new Error(r.error ?? "ipc error");
  },
}));

const capture = (...args: unknown[]) => {
  logOutput.push(args.map(String).join(" "));
};
const fakeLogger = {
  info: capture,
  warn: capture,
  error: capture,
  debug: () => {},
};

mock.module("../../logger.js", () => ({
  log: fakeLogger,
  getCliLogger: () => fakeLogger,
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerBackupCommand } = await import("../backup.js");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => {},
    writeOut: () => {},
  });
  registerBackupCommand(program);
  return program;
}

async function runCommand(args: string[]): Promise<{ exitCode: number }> {
  process.exitCode = 0;
  try {
    const program = buildProgram();
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  }
  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  return { exitCode };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = { ok: true, result: {} };
  logOutput = [];
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// enable
// ---------------------------------------------------------------------------

describe("backup enable", () => {
  test("basic enable sends backup_enable with no extra params", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        enabled: true,
        intervalHours: 6,
        retention: 3,
        offsite: { enabled: true },
      },
    };
    const { exitCode } = await runCommand(["backup", "enable"]);
    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("backup_enable");
    // Should not have intervalHours or retention if not specified
    expect((lastIpcCall!.params?.body as Record<string, unknown>)?.intervalHours).toBeUndefined();
    expect((lastIpcCall!.params?.body as Record<string, unknown>)?.retention).toBeUndefined();
    expect((lastIpcCall!.params?.body as Record<string, unknown>)?.offsiteEnabled).toBeUndefined();
  });

  test("--interval 12 --retention 7 sends correct params", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        enabled: true,
        intervalHours: 12,
        retention: 7,
        offsite: { enabled: true },
      },
    };
    const { exitCode } = await runCommand([
      "backup",
      "enable",
      "--interval",
      "12",
      "--retention",
      "7",
    ]);
    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("backup_enable");
    expect(lastIpcCall!.params).toEqual({ body: { intervalHours: 12, retention: 7 } });
  });

  test("--no-offsite sends offsiteEnabled: false", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        enabled: true,
        intervalHours: 6,
        retention: 3,
        offsite: { enabled: false },
      },
    };
    const { exitCode } = await runCommand(["backup", "enable", "--no-offsite"]);
    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("backup_enable");
    expect((lastIpcCall!.params?.body as Record<string, unknown>)?.offsiteEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// disable
// ---------------------------------------------------------------------------

describe("backup disable", () => {
  test("sends backup_disable", async () => {
    const { exitCode } = await runCommand(["backup", "disable"]);
    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("backup_disable");
  });
});

// ---------------------------------------------------------------------------
// destinations list
// ---------------------------------------------------------------------------

describe("backup destinations list", () => {
  test("sends backup_destinations_list", async () => {
    mockIpcResult = { ok: true, result: { destinations: [] } };
    const { exitCode } = await runCommand(["backup", "destinations", "list"]);
    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("backup_destinations_list");
  });
});

// ---------------------------------------------------------------------------
// destinations add
// ---------------------------------------------------------------------------

describe("backup destinations add", () => {
  test("sends backup_destinations_add with encrypt: true by default", async () => {
    mockIpcResult = {
      ok: true,
      result: { destinations: [{ path: "/tmp/foo", encrypt: true }] },
    };
    const { exitCode } = await runCommand([
      "backup",
      "destinations",
      "add",
      "/tmp/foo",
    ]);
    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("backup_destinations_add");
    expect(lastIpcCall!.params).toEqual({ body: { path: "/tmp/foo", encrypt: true } });
  });

  test("--plaintext sends encrypt: false", async () => {
    mockIpcResult = {
      ok: true,
      result: { destinations: [{ path: "/tmp/foo", encrypt: false }] },
    };
    const { exitCode } = await runCommand([
      "backup",
      "destinations",
      "add",
      "/tmp/foo",
      "--plaintext",
    ]);
    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("backup_destinations_add");
    expect(lastIpcCall!.params).toEqual({ body: { path: "/tmp/foo", encrypt: false } });
  });
});

// ---------------------------------------------------------------------------
// destinations remove
// ---------------------------------------------------------------------------

describe("backup destinations remove", () => {
  test("sends backup_destinations_remove with correct path", async () => {
    mockIpcResult = { ok: true, result: { destinations: [] } };
    const { exitCode } = await runCommand([
      "backup",
      "destinations",
      "remove",
      "/tmp/foo",
    ]);
    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("backup_destinations_remove");
    expect((lastIpcCall!.params?.body as Record<string, unknown>)?.path).toBe("/tmp/foo");
  });
});

// ---------------------------------------------------------------------------
// destinations set-encrypt
// ---------------------------------------------------------------------------

describe("backup destinations set-encrypt", () => {
  test("sends backup_destinations_set_encrypt with encrypt: true", async () => {
    mockIpcResult = {
      ok: true,
      result: { destination: { path: "/tmp/foo", encrypt: true } },
    };
    const { exitCode } = await runCommand([
      "backup",
      "destinations",
      "set-encrypt",
      "/tmp/foo",
      "true",
    ]);
    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("backup_destinations_set_encrypt");
    expect(lastIpcCall!.params).toEqual({ body: { path: "/tmp/foo", encrypt: true } });
  });

  test("invalid value exits with code 1 without calling IPC", async () => {
    const { exitCode } = await runCommand([
      "backup",
      "destinations",
      "set-encrypt",
      "/tmp/foo",
      "yes",
    ]);
    expect(exitCode).toBe(1);
    // IPC should not have been called since we validated locally
    expect(lastIpcCall).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("backup status", () => {
  test("successful status call exits with 0", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        enabled: true,
        intervalHours: 6,
        retention: 3,
        lastRunAt: null,
        nextRunAt: null,
        localDir: "/tmp/local",
        localSnapshotCount: 0,
        offsiteEnabled: false,
        offsite: [],
      },
    };
    const { exitCode } = await runCommand(["backup", "status"]);
    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("backup_status");
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("backup list", () => {
  test("sends backups_list", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        local: [],
        offsite: [],
        offsiteEnabled: false,
        nextRunAt: null,
      },
    };
    const { exitCode } = await runCommand(["backup", "list"]);
    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("backups_list");
  });
});

// ---------------------------------------------------------------------------
// IPC error path
// ---------------------------------------------------------------------------

describe("IPC error handling", () => {
  test("IPC error causes process.exitCode = 1", async () => {
    mockIpcResult = { ok: false, error: "daemon not running" };
    const { exitCode } = await runCommand(["backup", "disable"]);
    expect(exitCode).toBe(1);
  });
});
