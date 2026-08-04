/**
 * Tests for `assistant memory retrospective run`:
 *
 *   - the pure helpers behind the rewind flags (the `--from` / `--from-start`
 *     resolver and the cursor formatter), and
 *   - the run action itself, exercised through the commander program with
 *     every side-effecting dependency replaced by a recorder: the fork-based
 *     retrospective job, the state store (reads and writes), the accounting
 *     window counter, the config loader, and the conversation/message lookups.
 *
 * Every disk- or DB-touching module the action can lazily import is mocked,
 * so the recorders plus the captured stdout/log output are the action's
 * complete side-effect surface. The tests assert that dry runs and
 * validation failures perform zero writes, and that real runs delegate all
 * state mutation to the job (the CLI itself never writes).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

import type { MemoryRetrospectiveState } from "../../../../plugins/defaults/memory/memory-retrospective-state.js";
import { applyCommandHelp } from "../../../lib/cli-command-help.js";
import { memoryHelp } from "../index.help.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

interface JobCall {
  conversationId: string;
  config: unknown;
  options: { overrideCursor: string | null } | undefined;
}

/** Every `runForkBasedRetrospective` invocation, in order. */
let jobCalls: JobCall[] = [];

/** Outcome the job mock returns; overridable per test. */
let jobResult: unknown = { kind: "no_new_messages" };

/** Every state-store write, in order. Must stay empty in every test. */
let stateWrites: { fn: string; args: unknown[] }[] = [];

/** Conversation ids passed to `getRetrospectiveState`, in order. */
let stateReads: string[] = [];

/** Row `getRetrospectiveState` returns (null = no row). */
let stateRow: MemoryRetrospectiveState | null = null;

/** Every `getRetrospectiveMessagesAfter` call, in order. */
let accountingCalls: { conversationId: string; afterMessageId: unknown }[] = [];

/** Rows the accounting mock returns for the unprocessed window. */
let unprocessedMessages: unknown[] = [];

/** Conversation ids `getConversation` treats as existing. */
let knownConversationIds = new Set<string>();

/** Message ids `getMessageById` treats as existing. */
let knownMessageIds = new Set<string>();

/** Conversation ids passed to `getConversation`, in order. */
let conversationLookups: string[] = [];

/** Number of `getConfig` calls (each real call reads config from disk). */
let configCalls = 0;

/** Sentinel config object the loader mock returns. */
const sentinelConfig = { sentinel: "config" };

/** Captured log output for assertion. */
let logOutput: string[] = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module(
  "../../../../plugins/defaults/memory/memory-retrospective-job.js",
  () => ({
    runForkBasedRetrospective: async (
      conversationId: string,
      config: unknown,
      options?: { overrideCursor: string | null },
    ) => {
      jobCalls.push({ conversationId, config, options });
      return jobResult;
    },
  }),
);

mock.module(
  "../../../../plugins/defaults/memory/memory-retrospective-state.js",
  () => ({
    getRetrospectiveState: (conversationId: string) => {
      stateReads.push(conversationId);
      return stateRow;
    },
    listRetrospectiveStates: () => (stateRow ? [stateRow] : []),
    upsertRetrospectiveState: async (...args: unknown[]) => {
      stateWrites.push({ fn: "upsertRetrospectiveState", args });
    },
    appendToRememberedLog: (...args: unknown[]) => {
      stateWrites.push({ fn: "appendToRememberedLog", args });
      return [];
    },
    forkRetrospectiveState: (...args: unknown[]) => {
      stateWrites.push({ fn: "forkRetrospectiveState", args });
    },
    bumpRetrospectiveLastRunAt: async (...args: unknown[]) => {
      stateWrites.push({ fn: "bumpRetrospectiveLastRunAt", args });
    },
  }),
);

mock.module(
  "../../../../plugins/defaults/memory/memory-retrospective-accounting.js",
  () => ({
    getRetrospectiveMessagesAfter: (
      conversationId: string,
      afterMessageId: unknown,
    ) => {
      accountingCalls.push({ conversationId, afterMessageId });
      return unprocessedMessages;
    },
  }),
);

mock.module("../../../../persistence/conversation-crud.js", () => ({
  getConversation: (id: string) => {
    conversationLookups.push(id);
    return knownConversationIds.has(id) ? { id } : null;
  },
  getMessageById: (messageId: string, _conversationId: string) =>
    knownMessageIds.has(messageId) ? { id: messageId } : null,
}));

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => {
    configCalls += 1;
    return sentinelConfig;
  },
}));

const capture = (...args: unknown[]) => {
  logOutput.push(args.map((a) => JSON.stringify(a)).join(" "));
};
const fakeLogger = {
  info: capture,
  warn: capture,
  error: capture,
  debug: () => {},
};
mock.module("../../../../util/logger.js", () => ({
  getLogger: () => fakeLogger,
  getCliLogger: () => fakeLogger,
}));

// ---------------------------------------------------------------------------
// Import the module under test (after mocks)
// ---------------------------------------------------------------------------

const {
  describeCursor,
  registerMemoryRetrospectiveCommand,
  resolveRunCursorOverride,
} = await import("../memory-retrospective.js");

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
  const memory = program.command("memory");
  applyCommandHelp(memory, memoryHelp);
  registerMemoryRetrospectiveCommand(memory);
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
  return { stdout: stdoutChunks.join(""), exitCode };
}

const INVOKED_OUTCOME = {
  kind: "invoked",
  backgroundConversationId: "fork-conv-1",
  cutoffMessageId: "msg-9",
  newMessageCount: 3,
  followUpJobIds: [],
};

function sampleStateRow(): MemoryRetrospectiveState {
  return {
    conversationId: "conv-1",
    lastProcessedMessageId: "msg-5",
    lastRunAt: 1_720_000_000_000,
    rememberedLog: ["fact one", "fact two"],
  };
}

/** Asserts the action performed no writes through any recorded channel. */
function expectNoWrites(): void {
  expect(jobCalls).toHaveLength(0);
  expect(stateWrites).toHaveLength(0);
  expect(configCalls).toBe(0);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jobCalls = [];
  jobResult = { kind: "no_new_messages" };
  stateWrites = [];
  stateReads = [];
  stateRow = null;
  accountingCalls = [];
  unprocessedMessages = [];
  knownConversationIds = new Set(["conv-1"]);
  knownMessageIds = new Set(["msg-3"]);
  conversationLookups = [];
  configCalls = 0;
  logOutput = [];
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("resolveRunCursorOverride", () => {
  test("neither flag: default (persisted cursor is used)", () => {
    expect(resolveRunCursorOverride({})).toEqual({ kind: "default" });
  });

  test("--from-start resolves to a null override (replay from the beginning)", () => {
    expect(resolveRunCursorOverride({ fromStart: true })).toEqual({
      kind: "override",
      overrideCursor: null,
    });
  });

  test("--from <messageId> resolves to that id as the override", () => {
    expect(resolveRunCursorOverride({ from: "msg-123" })).toEqual({
      kind: "override",
      overrideCursor: "msg-123",
    });
  });

  test("--from and --from-start together are rejected", () => {
    const result = resolveRunCursorOverride({
      from: "msg-123",
      fromStart: true,
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("mutually exclusive");
    }
  });

  test("an empty --from value is rejected with a pointer to --from-start", () => {
    const result = resolveRunCursorOverride({ from: "" });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("--from-start");
    }
  });

  test("fromStart: false behaves as absent", () => {
    expect(resolveRunCursorOverride({ fromStart: false })).toEqual({
      kind: "default",
    });
    expect(
      resolveRunCursorOverride({ from: "msg-123", fromStart: false }),
    ).toEqual({ kind: "override", overrideCursor: "msg-123" });
  });
});

describe("describeCursor", () => {
  test("null and the empty-string sentinel render as the start of the conversation", () => {
    expect(describeCursor(null)).toBe("(start of conversation)");
    expect(describeCursor("")).toBe("(start of conversation)");
  });

  test("a concrete message id renders verbatim", () => {
    expect(describeCursor("msg-123")).toBe("msg-123");
  });
});

// ---------------------------------------------------------------------------
// run action: --dry-run
// ---------------------------------------------------------------------------

describe("run --dry-run", () => {
  test("performs zero writes and reports cursors, window size, lastRunAt, and log size", async () => {
    stateRow = sampleStateRow();
    unprocessedMessages = [{}, {}, {}];

    const { stdout, exitCode } = await runCommand([
      "memory",
      "retrospective",
      "run",
      "conv-1",
      "--dry-run",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      kind: "dry_run",
      conversationId: "conv-1",
      currentCursor: "msg-5",
      overrideCursor: "msg-5",
      unprocessedMessageCount: 3,
      lastRunAt: 1_720_000_000_000,
      rememberedLogEntryCount: 2,
    });

    expectNoWrites();
    // The window is counted from the current cursor (a read-only lookup).
    expect(accountingCalls).toEqual([
      { conversationId: "conv-1", afterMessageId: "msg-5" },
    ]);
  });

  test("--from-start --dry-run reports the override target without writing", async () => {
    stateRow = sampleStateRow();
    unprocessedMessages = [{}, {}, {}, {}, {}];

    const { stdout, exitCode } = await runCommand([
      "memory",
      "retrospective",
      "run",
      "conv-1",
      "--from-start",
      "--dry-run",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.currentCursor).toBe("msg-5");
    expect(report.overrideCursor).toBeNull();
    expect(report.unprocessedMessageCount).toBe(5);

    expectNoWrites();
    expect(accountingCalls).toEqual([
      { conversationId: "conv-1", afterMessageId: null },
    ]);
  });

  test("a conversation with no state row reports null cursor and empty log", async () => {
    stateRow = null;
    unprocessedMessages = [{}];

    const { stdout, exitCode } = await runCommand([
      "memory",
      "retrospective",
      "run",
      "conv-1",
      "--dry-run",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      kind: "dry_run",
      conversationId: "conv-1",
      currentCursor: null,
      overrideCursor: null,
      unprocessedMessageCount: 1,
      lastRunAt: null,
      rememberedLogEntryCount: 0,
    });
    expectNoWrites();
  });
});

// ---------------------------------------------------------------------------
// run action: validation failures happen before any mutation
// ---------------------------------------------------------------------------

describe("run validation", () => {
  test("an unknown conversation id fails before any mutation", async () => {
    knownConversationIds = new Set();

    const { stdout, exitCode } = await runCommand([
      "memory",
      "retrospective",
      "run",
      "conv-missing",
      "--from",
      "msg-3",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const payload = JSON.parse(stdout);
    expect(payload.kind).toBe("error");
    expect(payload.error).toContain("Conversation not found: conv-missing");

    expectNoWrites();
    expect(stateReads).toHaveLength(0);
    expect(accountingCalls).toHaveLength(0);
  });

  test("--from with a message id outside the conversation fails before any mutation", async () => {
    const { stdout, exitCode } = await runCommand([
      "memory",
      "retrospective",
      "run",
      "conv-1",
      "--from",
      "msg-404",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const payload = JSON.parse(stdout);
    expect(payload.kind).toBe("error");
    expect(payload.error).toContain("msg-404");
    expect(payload.error).toContain("not found");

    expectNoWrites();
    expect(stateReads).toHaveLength(0);
  });

  test("--from together with --from-start fails before any work at all", async () => {
    const { stdout, exitCode } = await runCommand([
      "memory",
      "retrospective",
      "run",
      "conv-1",
      "--from",
      "msg-3",
      "--from-start",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const payload = JSON.parse(stdout);
    expect(payload.kind).toBe("error");
    expect(payload.error).toContain("mutually exclusive");

    expectNoWrites();
    // Flag resolution fails before validation, so nothing is even read.
    expect(conversationLookups).toHaveLength(0);
    expect(stateReads).toHaveLength(0);
    expect(accountingCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// run action: job delegation
// ---------------------------------------------------------------------------

describe("run job delegation", () => {
  test("a failed replay (no_usable_output) is reported and the CLI writes nothing on top", async () => {
    jobResult = {
      kind: "no_usable_output",
      reason: "verifier rejected the transcript",
      conversationId: "fork-conv-1",
    };

    const { exitCode } = await runCommand([
      "memory",
      "retrospective",
      "run",
      "conv-1",
    ]);

    expect(exitCode).toBe(1);
    expect(jobCalls).toHaveLength(1);
    expect(jobCalls[0].conversationId).toBe("conv-1");
    expect(jobCalls[0].options).toBeUndefined();
    // State ownership stays with the job: the CLI adds no writes of its own.
    expect(stateWrites).toHaveLength(0);
    expect(logOutput.join("\n")).toContain("no usable output");
    expect(logOutput.join("\n")).toContain("verifier rejected the transcript");
  });

  test("a plain run passes no overrideCursor and prints the outcome", async () => {
    jobResult = INVOKED_OUTCOME;

    const { stdout, exitCode } = await runCommand([
      "memory",
      "retrospective",
      "run",
      "conv-1",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(jobCalls).toHaveLength(1);
    expect(jobCalls[0].config).toBe(sentinelConfig);
    expect(jobCalls[0].options).toBeUndefined();
    expect(JSON.parse(stdout)).toEqual(INVOKED_OUTCOME);
    expect(stateWrites).toHaveLength(0);
    // A plain run defers validation to the job itself.
    expect(conversationLookups).toHaveLength(0);
  });

  test("--from-start passes a null overrideCursor and prints the resulting state row", async () => {
    jobResult = INVOKED_OUTCOME;
    stateRow = sampleStateRow();

    const { stdout, exitCode } = await runCommand([
      "memory",
      "retrospective",
      "run",
      "conv-1",
      "--from-start",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(jobCalls).toHaveLength(1);
    expect(jobCalls[0].options).toEqual({ overrideCursor: null });
    expect(JSON.parse(stdout)).toEqual({
      outcome: INVOKED_OUTCOME,
      state: sampleStateRow(),
    });
    expect(stateWrites).toHaveLength(0);
  });

  test("--from <messageId> passes that id as the overrideCursor", async () => {
    jobResult = INVOKED_OUTCOME;
    stateRow = sampleStateRow();

    const { stdout, exitCode } = await runCommand([
      "memory",
      "retrospective",
      "run",
      "conv-1",
      "--from",
      "msg-3",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(jobCalls).toHaveLength(1);
    expect(jobCalls[0].options).toEqual({ overrideCursor: "msg-3" });
    // The rewind run re-reads and prints the post-run state row.
    expect(JSON.parse(stdout).state).toEqual(sampleStateRow());
    expect(stateWrites).toHaveLength(0);
  });

  test("repeating the same --from replay invokes the job identically and never writes state directly", async () => {
    jobResult = INVOKED_OUTCOME;
    stateRow = sampleStateRow();

    const args = [
      "memory",
      "retrospective",
      "run",
      "conv-1",
      "--from",
      "msg-3",
      "--json",
    ];
    const first = await runCommand(args);
    const second = await runCommand(args);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    expect(jobCalls).toHaveLength(2);
    expect(jobCalls[0].options).toEqual({ overrideCursor: "msg-3" });
    expect(jobCalls[1].options).toEqual(jobCalls[0].options);
    // Advancement idempotence lives in the job; the CLI adds zero writes
    // across repeats.
    expect(stateWrites).toHaveLength(0);
  });
});
