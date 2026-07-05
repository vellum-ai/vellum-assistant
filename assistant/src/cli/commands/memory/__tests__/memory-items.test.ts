/**
 * Tests for the `assistant memory` item CRUD verbs (list/get/create/update/delete).
 *
 * Validates:
 *   - Verb registration directly under the `memory` namespace.
 *   - Each verb maps to the right `cliIpcCall` method with the right
 *     pathParams/queryParams/body shape.
 *   - Local validation (missing update flags, invalid --importance, blank ID)
 *     fails before any IPC call.
 *   - `delete` refuses to run non-interactively without --force.
 *   - IPC error paths return a non-zero exit code without throwing.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** The last `cliIpcCall` invocation captured for assertions. */
let lastIpcCall: {
  method: string;

  params?: any;
} | null = null;

/** The result that cliIpcCall will return. */
let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
} = { ok: true, result: {} };

/** Captured log output for assertion. */
let logOutput: string[] = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: unknown) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
  exitFromIpcResult: (r: { error?: string; statusCode?: number }) => {
    process.exitCode =
      r.statusCode === undefined
        ? 10
        : r.statusCode >= 500
          ? 3
          : r.statusCode >= 400
            ? 2
            : 1;
    throw new Error(r.error ?? "Unknown error");
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
mock.module("../../../logger.js", () => ({
  log: fakeLogger,
  getCliLogger: () => fakeLogger,
}));

// Sibling subgroups pull in daemon-side modules (retrospective imports the
// job handler directly); stub them out — the item verbs are what's under test.
mock.module("../memory-v2.js", () => ({
  registerMemoryV2Command: () => {},
}));
mock.module("../memory-v3.js", () => ({
  registerMemoryV3Command: () => {},
}));
mock.module("../memory-retrospective.js", () => ({
  registerMemoryRetrospectiveCommand: () => {},
}));
mock.module("../worker.js", () => ({
  registerMemoryWorkerCommand: () => {},
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerMemoryCommand } = await import("../index.js");

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
  registerMemoryCommand(program);
  return program;
}

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
    const program = buildProgram();
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) {
      process.exitCode = 1;
    }
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return { exitCode, stdout: stdoutChunks.join("") };
}

const ITEM = {
  id: "9f2c4f3a-3f1a-41e4-88e7-abc123def456",
  kind: "semantic",
  subject: "Coffee preference",
  statement: "Prefers oat-milk lattes",
  status: "active",
  confidence: 0.95,
  importance: 0.8,
  firstSeenAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_000_000,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = { ok: true, result: { item: ITEM } };
  logOutput = [];
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("verb registration", () => {
  test("registers item CRUD verbs directly under memory", () => {
    const program = buildProgram();
    const memory = program.commands.find((c) => c.name() === "memory");
    expect(memory).toBeDefined();
    const names = memory!.commands.map((c) => c.name());
    for (const verb of ["list", "get", "create", "update", "delete"]) {
      expect(names).toContain(verb);
    }
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("memory list", () => {
  test("calls listMemoryItems with only the provided filters", async () => {
    mockIpcResult = {
      ok: true,
      result: { items: [ITEM], total: 1, kindCounts: { semantic: 1 } },
    };
    const { exitCode } = await runCommand([
      "memory",
      "list",
      "--kind",
      "semantic",
      "--limit",
      "20",
    ]);
    expect(exitCode).toBe(0);
    expect(lastIpcCall?.method).toBe("listMemoryItems");
    expect(lastIpcCall?.params).toEqual({
      queryParams: { kind: "semantic", limit: "20" },
    });
  });

  test("--json emits the raw response", async () => {
    mockIpcResult = {
      ok: true,
      result: { items: [ITEM], total: 1, kindCounts: { semantic: 1 } },
    };
    const { exitCode, stdout } = await runCommand(["memory", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.total).toBe(1);
    expect(parsed.items[0].id).toBe(ITEM.id);
  });

  test("IPC failure exits non-zero", async () => {
    mockIpcResult = { ok: false, error: "boom", statusCode: 500 };
    const { exitCode } = await runCommand(["memory", "list"]);
    expect(exitCode).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe("memory get", () => {
  test("calls getMemoryItem with pathParams.id", async () => {
    const { exitCode } = await runCommand(["memory", "get", ITEM.id]);
    expect(exitCode).toBe(0);
    expect(lastIpcCall?.method).toBe("getMemoryItem");
    expect(lastIpcCall?.params).toEqual({ pathParams: { id: ITEM.id } });
  });

  test("blank ID fails without an IPC call", async () => {
    const { exitCode } = await runCommand(["memory", "get", "  "]);
    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("not-found error exits with 4xx code", async () => {
    mockIpcResult = {
      ok: false,
      error: "Memory item not found",
      statusCode: 404,
    };
    const { exitCode } = await runCommand(["memory", "get", ITEM.id]);
    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("memory create", () => {
  test("calls createMemoryItem with the assembled body", async () => {
    const { exitCode } = await runCommand([
      "memory",
      "create",
      "--kind",
      "semantic",
      "--statement",
      "Prefers oat-milk lattes",
      "--subject",
      "Coffee preference",
      "--importance",
      "0.9",
    ]);
    expect(exitCode).toBe(0);
    expect(lastIpcCall?.method).toBe("createMemoryItem");
    expect(lastIpcCall?.params).toEqual({
      body: {
        kind: "semantic",
        statement: "Prefers oat-milk lattes",
        subject: "Coffee preference",
        importance: 0.9,
      },
    });
    expect(logOutput.join("\n")).toContain(ITEM.id);
  });

  test("rejects out-of-range --importance before IPC", async () => {
    const { exitCode } = await runCommand([
      "memory",
      "create",
      "--kind",
      "semantic",
      "--statement",
      "x",
      "--importance",
      "3",
    ]);
    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("missing required --statement fails parse", async () => {
    const { exitCode } = await runCommand([
      "memory",
      "create",
      "--kind",
      "semantic",
    ]);
    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("memory update", () => {
  test("calls updateMemoryItem with pathParams and partial body", async () => {
    const { exitCode } = await runCommand([
      "memory",
      "update",
      ITEM.id,
      "--statement",
      "Prefers tea",
      "--importance",
      "0.5",
    ]);
    expect(exitCode).toBe(0);
    expect(lastIpcCall?.method).toBe("updateMemoryItem");
    expect(lastIpcCall?.params).toEqual({
      pathParams: { id: ITEM.id },
      body: { statement: "Prefers tea", importance: 0.5 },
    });
  });

  test("requires at least one update flag", async () => {
    const { exitCode } = await runCommand(["memory", "update", ITEM.id]);
    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
    expect(logOutput.join("\n")).toContain("At least one update flag");
  });

  test("--status active is forwarded (restore path)", async () => {
    const { exitCode } = await runCommand([
      "memory",
      "update",
      ITEM.id,
      "--status",
      "active",
    ]);
    expect(exitCode).toBe(0);
    expect(lastIpcCall?.params).toEqual({
      pathParams: { id: ITEM.id },
      body: { status: "active" },
    });
  });

  test("conflict error exits with 4xx code", async () => {
    mockIpcResult = {
      ok: false,
      error: "Another memory item with this content already exists",
      statusCode: 409,
    };
    const { exitCode } = await runCommand([
      "memory",
      "update",
      ITEM.id,
      "--statement",
      "dupe",
    ]);
    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("memory delete", () => {
  test("--force calls deleteMemoryItem without prompting", async () => {
    mockIpcResult = { ok: true, result: null };
    const { exitCode } = await runCommand([
      "memory",
      "delete",
      ITEM.id,
      "--force",
    ]);
    expect(exitCode).toBe(0);
    expect(lastIpcCall?.method).toBe("deleteMemoryItem");
    expect(lastIpcCall?.params).toEqual({ pathParams: { id: ITEM.id } });
    expect(logOutput.join("\n")).toContain(`Deleted memory item: ${ITEM.id}`);
  });

  test("refuses non-interactive delete without --force", async () => {
    // Tests run with stdin not a TTY, so the confirm prompt refuses.
    mockIpcResult = { ok: true, result: null };
    const { exitCode } = await runCommand(["memory", "delete", ITEM.id]);
    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("--force --json emits a deletion envelope", async () => {
    mockIpcResult = { ok: true, result: null };
    const { exitCode, stdout } = await runCommand([
      "memory",
      "delete",
      ITEM.id,
      "--force",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ deleted: true, id: ITEM.id });
  });

  test("IPC failure exits non-zero", async () => {
    mockIpcResult = {
      ok: false,
      error: "Memory item not found",
      statusCode: 404,
    };
    const { exitCode } = await runCommand([
      "memory",
      "delete",
      ITEM.id,
      "--force",
    ]);
    expect(exitCode).toBe(2);
  });
});
