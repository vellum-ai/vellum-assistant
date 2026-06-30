/**
 * Tests for `conversations new --json` — the flag emits a machine-readable
 * result (incl. the new id) so callers can capture it without scraping the log.
 */

import * as nodeFs from "node:fs";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

let lastIpcCall: { method: string; params?: Record<string, unknown> } | null =
  null;
const loggerCalls: { level: string; msg: string }[] = [];

// Reassigned per-test so a single mock can stand in for success and failure.
let mockIpcResult: { ok: boolean; result?: unknown; error?: string } = {
  ok: true,
  result: {
    id: "conv-new-1",
    title: "GitHub watcher",
    conversationKey: "key-1",
    messagesInserted: 0,
  },
};

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
  exitCodeFromIpcResult: (r: { statusCode?: number }) =>
    r.statusCode === undefined
      ? 10
      : r.statusCode >= 500
        ? 3
        : r.statusCode >= 400
          ? 2
          : 1,
  exitFromIpcResult: (r: { error?: string }) => {
    process.exitCode = 1;
    loggerCalls.push({ level: "error", msg: r.error ?? "Unknown error" });
  },
}));

const fakeLogger = {
  info: (m: unknown) => loggerCalls.push({ level: "info", msg: String(m) }),
  warn: () => {},
  error: (m: unknown) => loggerCalls.push({ level: "error", msg: String(m) }),
  debug: () => {},
};

mock.module("../../../util/logger.js", () => ({
  getLogger: () => fakeLogger,
  getCliLogger: () => fakeLogger,
  initLogger: () => {},
  truncateForLog: (v: string) => v,
  pruneOldLogFiles: () => 0,
  LOG_FILE_PATTERN: /^assistant-(\d{4}-\d{2}-\d{2})\.log$/,
  getCurrentLogFilePath: () => "/tmp/test-assistant.log",
}));

// node:fs must stay fully functional for conversations.js's heavy import graph
// — a partial mock deadlocks it — so spread the real module.
const realFs = { ...nodeFs };
mock.module("node:fs", () => ({ ...realFs }));

const { registerConversationsCommand } = await import("../conversations.js");

async function runNew(args: string[]): Promise<number> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerConversationsCommand(program);
  try {
    await program.parseAsync(["node", "assistant", "conversations", ...args]);
  } catch {
    if (process.exitCode === 0 || process.exitCode === undefined) {
      process.exitCode = 1;
    }
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return code;
}

/** Parse the last info line as JSON (the `--json` path emits one JSON line). */
function jsonOutput(): Record<string, unknown> {
  const info = loggerCalls.filter((c) => c.level === "info");
  const last = info[info.length - 1];
  if (!last) throw new Error("no info output captured");
  return JSON.parse(last.msg) as Record<string, unknown>;
}

let savedRunId: string | undefined;

beforeEach(() => {
  lastIpcCall = null;
  loggerCalls.length = 0;
  process.exitCode = 0;
  // Clear __SCHEDULE_RUN_ID so it can't leak conversationType into the body.
  savedRunId = process.env.__SCHEDULE_RUN_ID;
  delete process.env.__SCHEDULE_RUN_ID;
});

describe("conversations new --json", () => {
  test("--json emits a parseable result with the new conversation id", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        id: "conv-new-1",
        title: "GitHub watcher",
        conversationKey: "key-1",
        messagesInserted: 0,
      },
    };
    const code = await runNew(["new", "GitHub watcher", "--json"]);
    expect(code).toBe(0);
    expect(lastIpcCall?.method).toBe("conversation_create_cli");
    expect(jsonOutput()).toMatchObject({
      ok: true,
      id: "conv-new-1",
      conversationKey: "key-1",
    });
  });

  test("without --json, prints the human line and not JSON", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        id: "conv-new-2",
        title: "Notes",
        conversationKey: "key-2",
        messagesInserted: 0,
      },
    };
    const code = await runNew(["new", "Notes"]);
    expect(code).toBe(0);
    const info = loggerCalls.filter((c) => c.level === "info").map((c) => c.msg);
    expect(
      info.some((m) => m.includes("Created conversation: Notes (conv-new-2)")),
    ).toBe(true);
    expect(() => JSON.parse(info[info.length - 1]!)).toThrow();
  });

  test("--json reports failure as { ok: false } and exits non-zero", async () => {
    mockIpcResult = { ok: false, error: "daemon not running" };
    const code = await runNew(["new", "X", "--json"]);
    expect(code).toBe(1);
    expect(jsonOutput()).toEqual({ ok: false, error: "daemon not running" });
  });

  test("--json reports a seed-file error as { ok: false } before any IPC", async () => {
    const code = await runNew([
      "new",
      "X",
      "--content-file",
      "/no/such/seed-file.json",
      "--json",
    ]);
    expect(code).toBe(1);
    expect(lastIpcCall).toBeNull(); // validation fails before any IPC call
    expect(jsonOutput()).toMatchObject({ ok: false });
  });

  test("under a script-mode schedule, creates the conversation as scheduled", async () => {
    process.env.__SCHEDULE_RUN_ID = "run-9";
    mockIpcResult = {
      ok: true,
      result: {
        id: "conv-new-3",
        title: "GitHub watcher",
        conversationKey: "key-3",
        messagesInserted: 0,
      },
    };
    await runNew(["new", "GitHub watcher", "--json"]);
    const body = (lastIpcCall?.params as { body?: Record<string, unknown> })
      ?.body;
    expect(body?.conversationType).toBe("scheduled");
  });
});

afterEach(() => {
  if (savedRunId !== undefined) process.env.__SCHEDULE_RUN_ID = savedRunId;
  process.exitCode = 0;
});
