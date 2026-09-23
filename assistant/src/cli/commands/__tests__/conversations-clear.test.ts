import * as nodeFs from "node:fs";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

let lastIpcCall: { method: string; params?: Record<string, unknown> } | null =
  null;
const loggerCalls: { level: string; msg: string }[] = [];
let promptAnswer = "";
let prompted = false;

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    return { ok: true, result: { cleared: 3 } };
  },
  exitCodeFromIpcResult: () => 1,
  exitFromIpcResult: () => {
    process.exitCode = 1;
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

mock.module("node:readline", () => ({
  createInterface: () => ({
    question: (_q: string, cb: (a: string) => void) => {
      prompted = true;
      cb(promptAnswer);
    },
    close: () => {},
  }),
}));

// node:fs must stay fully functional for conversations.js's heavy import graph.
const realFs = { ...nodeFs };
mock.module("node:fs", () => ({ ...realFs }));

const { registerConversationsCommand } = await import("../conversations.js");

async function runClear(args: string[]): Promise<number> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerConversationsCommand(program);
  await program.parseAsync([
    "node",
    "assistant",
    "conversations",
    "clear",
    ...args,
  ]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return code;
}

const savedIsTTY = process.stdin.isTTY;

beforeEach(() => {
  lastIpcCall = null;
  loggerCalls.length = 0;
  prompted = false;
  process.exitCode = 0;
});

afterEach(() => {
  process.stdin.isTTY = savedIsTTY;
});

describe("conversations clear", () => {
  test("interactive: Enter cancels without clearing", async () => {
    process.stdin.isTTY = true;
    promptAnswer = "";
    expect(await runClear([])).toBe(0);
    expect(prompted).toBe(true);
    expect(lastIpcCall).toBeNull();
    expect(loggerCalls.some((c) => c.msg === "Cancelled")).toBe(true);
  });

  test("interactive: y clears with the destructive-confirmation header", async () => {
    process.stdin.isTTY = true;
    promptAnswer = "y";
    expect(await runClear([])).toBe(0);
    expect(lastIpcCall).toEqual({
      method: "conversations_clear_cli",
      params: {
        headers: { "x-confirm-destructive": "clear-all-conversations" },
      },
    });
  });

  test("non-TTY without --yes fails fast naming the flag", async () => {
    process.stdin.isTTY = false;
    expect(await runClear([])).toBe(1);
    expect(prompted).toBe(false);
    expect(lastIpcCall).toBeNull();
    expect(
      loggerCalls.some((c) => c.level === "error" && c.msg.includes("--yes")),
    ).toBe(true);
  });

  test("non-TTY with --yes clears without prompting", async () => {
    process.stdin.isTTY = false;
    expect(await runClear(["--yes"])).toBe(0);
    expect(prompted).toBe(false);
    expect(lastIpcCall?.params).toEqual({
      headers: { "x-confirm-destructive": "clear-all-conversations" },
    });
    expect(loggerCalls.some((c) => c.msg.includes("Cleared 3"))).toBe(true);
  });
});
