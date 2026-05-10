/**
 * Tests for the `assistant conversations` CLI command.
 *
 * Validates:
 *   - Subcommand registration (list, new, rename, export, clear, wipe, wake)
 *   - IPC call method and params for each subcommand
 *   - Output formatting
 *   - Exit codes on IPC failures
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

/** All IPC calls captured (for multi-call scenarios). */
let allIpcCalls: Array<{ method: string; params?: Record<string, unknown> }> =
  [];

/** The result that cliIpcCall will return (can be set per-test). */
let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
} = { ok: true, result: {} };

/** A queue of results for multi-call scenarios (consumed in order). */
let ipcResultQueue: Array<{ ok: boolean; result?: unknown; error?: string }> =
  [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    allIpcCalls.push({ method, params });
    if (ipcResultQueue.length > 0) {
      return ipcResultQueue.shift()!;
    }
    return mockIpcResult;
  },
  exitFromIpcResult: (r: { ok: false; error?: string }) => {
    process.stderr.write((r.error ?? "Unknown error") + "\n");
    process.exitCode = 1;
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
    info: (msg: string) => {
      capturedLogs.push(msg);
    },
    warn: () => {},
    error: (msg: string) => {
      capturedErrors.push(msg);
    },
    debug: () => {},
  }),
}));

// Mock conversations-defer and conversations-import to avoid loading daemon internals
mock.module("../conversations-defer.js", () => ({
  registerConversationsDeferCommand: () => {},
}));

mock.module("../conversations-import.js", () => ({
  registerConversationsImportCommand: () => {},
}));

// ---------------------------------------------------------------------------
// Log capture
// ---------------------------------------------------------------------------

let capturedLogs: string[] = [];
let capturedErrors: string[] = [];

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerConversationsCommand } = await import("../conversations.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; exitCode: number; logs: string[]; errors: string[] }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];

  capturedLogs = [];
  capturedErrors = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = (() => true) as typeof process.stderr.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerConversationsCommand(program);
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
    logs: [...capturedLogs],
    errors: [...capturedErrors],
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastIpcCall = null;
  allIpcCalls = [];
  ipcResultQueue = [];
  mockIpcResult = { ok: true, result: {} };
  capturedLogs = [];
  capturedErrors = [];
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// conversations list
// ---------------------------------------------------------------------------

describe("conversations list", () => {
  test("calls listConversations IPC and prints conversation info", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        conversations: [
          {
            id: "conv-abc123",
            title: "Project planning",
            updatedAt: Date.now() - 3600_000,
          },
        ],
      },
    };

    const { exitCode, logs } = await runCommand(["conversations", "list"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("listConversations");
    const logLine = logs.join(" ");
    expect(logLine).toContain("conv-abc123");
    expect(logLine).toContain("Project planning");
  });

  test("shows 'No conversations' when list is empty", async () => {
    mockIpcResult = { ok: true, result: { conversations: [] } };

    const { exitCode, logs } = await runCommand(["conversations", "list"]);

    expect(exitCode).toBe(0);
    expect(logs.join(" ")).toContain("No conversations");
  });

  test("--include-archived passes includeArchived in queryParams", async () => {
    mockIpcResult = { ok: true, result: { conversations: [] } };

    await runCommand(["conversations", "list", "--include-archived"]);

    expect(lastIpcCall!.method).toBe("listConversations");
    expect(
      (lastIpcCall!.params as Record<string, unknown>)?.queryParams,
    ).toEqual({ includeArchived: "true" });
  });

  test("IPC failure sets exit code 1", async () => {
    mockIpcResult = { ok: false, error: "Connection refused" };

    const { exitCode } = await runCommand(["conversations", "list"]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// conversations new
// ---------------------------------------------------------------------------

describe("conversations new", () => {
  test("calls createConversation with empty body when no title given", async () => {
    mockIpcResult = {
      ok: true,
      result: { id: "conv-new-1", title: "New Conversation" },
    };

    const { exitCode } = await runCommand(["conversations", "new"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("createConversation");
    expect((lastIpcCall!.params as Record<string, unknown>)?.body).toEqual({
      title: undefined,
    });
  });

  test("passes title in body when provided", async () => {
    mockIpcResult = {
      ok: true,
      result: { id: "conv-new-2", title: "My title" },
    };

    await runCommand(["conversations", "new", "My title"]);

    expect(lastIpcCall!.method).toBe("createConversation");
    expect(
      ((lastIpcCall!.params as Record<string, unknown>)?.body as Record<string, unknown>)
        ?.title,
    ).toBe("My title");
  });

  test("prints created conversation info", async () => {
    mockIpcResult = {
      ok: true,
      result: { id: "conv-xyz", title: "Test Conv" },
    };

    const { exitCode, logs } = await runCommand([
      "conversations",
      "new",
      "Test Conv",
    ]);

    expect(exitCode).toBe(0);
    expect(logs.join(" ")).toContain("conv-xyz");
    expect(logs.join(" ")).toContain("Test Conv");
  });

  test("IPC failure sets exit code 1", async () => {
    mockIpcResult = { ok: false, error: "Daemon unavailable" };

    const { exitCode } = await runCommand(["conversations", "new"]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// conversations rename
// ---------------------------------------------------------------------------

describe("conversations rename", () => {
  test("calls rename_conversation with correct body", async () => {
    mockIpcResult = { ok: true, result: { ok: true } };

    const { exitCode } = await runCommand([
      "conversations",
      "rename",
      "abc123",
      "New Name",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("rename_conversation");
    expect(lastIpcCall!.params).toEqual({
      body: { conversationId: "abc123", title: "New Name" },
    });
  });

  test("IPC failure sets exit code", async () => {
    mockIpcResult = { ok: false, error: "Not found" };

    const { exitCode } = await runCommand([
      "conversations",
      "rename",
      "abc123",
      "New Name",
    ]);

    expect(exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// conversations export
// ---------------------------------------------------------------------------

describe("conversations export", () => {
  const mockConvResult = {
    ok: true,
    conversation: {
      id: "conv-abc123",
      title: "Test Conversation",
      createdAt: 1700000000000,
      updatedAt: 1700001000000,
    },
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
        createdAt: 1700000500000,
      },
    ],
  };

  test("calls conversation_export IPC with correct pathParams", async () => {
    mockIpcResult = { ok: true, result: mockConvResult };

    await runCommand(["conversations", "export", "abc123"]);

    expect(lastIpcCall!.method).toBe("conversation_export");
    expect(lastIpcCall!.params).toEqual({ pathParams: { id: "abc123" } });
  });

  test("exports in markdown format by default", async () => {
    mockIpcResult = { ok: true, result: mockConvResult };

    const { stdout } = await runCommand(["conversations", "export", "abc123"]);

    expect(stdout).toContain("# Test Conversation");
    expect(stdout).toContain("conv-abc123");
  });

  test("--format json uses JSON formatter", async () => {
    mockIpcResult = { ok: true, result: mockConvResult };

    const { stdout } = await runCommand([
      "conversations",
      "export",
      "abc123",
      "--format",
      "json",
    ]);

    const parsed = JSON.parse(stdout);
    expect(parsed.id).toBe("conv-abc123");
    expect(parsed.title).toBe("Test Conversation");
    expect(Array.isArray(parsed.messages)).toBe(true);
  });

  test("fetches most recent conversation when no ID given", async () => {
    // First call: listConversations; Second call: conversation_export
    ipcResultQueue = [
      { ok: true, result: { conversations: [{ id: "conv-latest" }] } },
      { ok: true, result: mockConvResult },
    ];

    await runCommand(["conversations", "export"]);

    expect(allIpcCalls[0].method).toBe("listConversations");
    expect(allIpcCalls[1].method).toBe("conversation_export");
    expect(
      (allIpcCalls[1].params as Record<string, unknown>)?.pathParams,
    ).toEqual({ id: "conv-latest" });
  });

  test("IPC failure sets exit code 1", async () => {
    mockIpcResult = { ok: false, error: "Not found" };

    const { exitCode } = await runCommand([
      "conversations",
      "export",
      "abc123",
    ]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// conversations clear
// ---------------------------------------------------------------------------

describe("conversations clear", () => {
  test("calls clearAllConversations with confirm body after 'y' answer", async () => {
    mockIpcResult = { ok: true, result: undefined };

    // Mock readline to answer "y"
    const originalCreateInterface = (await import("node:readline"))
      .createInterface;
    mock.module("node:readline", () => ({
      createInterface: () => ({
        question: (_prompt: string, cb: (answer: string) => void) => {
          cb("y");
        },
        close: () => {},
      }),
    }));

    try {
      const { exitCode } = await runCommand(["conversations", "clear"]);

      expect(exitCode).toBe(0);
      expect(lastIpcCall!.method).toBe("clearAllConversations");
      expect(lastIpcCall!.params).toEqual({
        body: { confirm: "clear-all-conversations" },
      });
    } finally {
      mock.module("node:readline", () => ({
        createInterface: originalCreateInterface,
      }));
    }
  });

  test("cancels when user answers 'n'", async () => {
    mock.module("node:readline", () => ({
      createInterface: () => ({
        question: (_prompt: string, cb: (answer: string) => void) => {
          cb("n");
        },
        close: () => {},
      }),
    }));

    const { exitCode, logs } = await runCommand(["conversations", "clear"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeNull();
    expect(logs.join(" ")).toContain("Cancelled");
  });

  test("IPC failure sets exit code 1", async () => {
    mock.module("node:readline", () => ({
      createInterface: () => ({
        question: (_prompt: string, cb: (answer: string) => void) => {
          cb("y");
        },
        close: () => {},
      }),
    }));

    mockIpcResult = { ok: false, error: "Server error" };

    const { exitCode } = await runCommand(["conversations", "clear"]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// conversations wipe
// ---------------------------------------------------------------------------

describe("conversations wipe", () => {
  test("--yes skips confirmation and calls wipeConversation with pathParams", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        wiped: true,
        unsupersededItems: 3,
        deletedSummaries: 1,
        cancelledJobs: 0,
      },
    };

    const { exitCode, logs } = await runCommand([
      "conversations",
      "wipe",
      "abc123",
      "--yes",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("wipeConversation");
    expect(lastIpcCall!.params).toEqual({ pathParams: { id: "abc123" } });
    expect(logs.join(" ")).toContain("abc123");
    expect(logs.join(" ")).toContain("3 memory items");
  });

  test("IPC error on wipe sets exit code 1 and logs error", async () => {
    mockIpcResult = { ok: false, error: "Conversation not found" };

    const { exitCode, errors } = await runCommand([
      "conversations",
      "wipe",
      "missing-id",
      "--yes",
    ]);

    expect(exitCode).toBe(1);
    expect(errors.join(" ")).toContain("Wipe failed");
  });
});

// ---------------------------------------------------------------------------
// conversations wake
// ---------------------------------------------------------------------------

describe("conversations wake", () => {
  test("calls wake_conversation with conversationId, hint, source", async () => {
    mockIpcResult = {
      ok: true,
      result: { invoked: true, producedToolCalls: false },
    };

    const { exitCode } = await runCommand([
      "conversations",
      "wake",
      "abc123",
      "--hint",
      "test hint",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("wake_conversation");
    expect(
      (lastIpcCall!.params as Record<string, unknown>)?.body,
    ).toMatchObject({
      conversationId: "abc123",
      hint: "test hint",
    });
  });

  test("IPC error sets exit code 1", async () => {
    mockIpcResult = { ok: false, error: "Daemon unavailable" };

    const { exitCode } = await runCommand([
      "conversations",
      "wake",
      "abc123",
      "--hint",
      "test",
    ]);

    expect(exitCode).toBe(1);
  });
});
