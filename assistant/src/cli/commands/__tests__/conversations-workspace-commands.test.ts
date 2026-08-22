import * as nodeFs from "node:fs";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

let lastIpcCall: { method: string; params?: Record<string, unknown> } | null =
  null;
const loggerCalls: { level: string; msg: string }[] = [];

let mockIpcResult: { ok: boolean; result?: unknown; error?: string } = {
  ok: true,
  result: { conversationId: "conv-xyz", enabled: true },
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

const realFs = { ...nodeFs };
mock.module("node:fs", () => ({ ...realFs }));

const { registerConversationsCommand } = await import("../conversations.js");

async function run(args: string[]): Promise<number> {
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

beforeEach(() => {
  lastIpcCall = null;
  loggerCalls.length = 0;
  process.exitCode = 0;
  mockIpcResult = {
    ok: true,
    result: { conversationId: "conv-xyz", enabled: true },
  };
});

afterEach(() => {
  process.exitCode = 0;
});

describe("conversations workspace-commands", () => {
  test("allow sends enabled true for a conversation id", async () => {
    const code = await run([
      "workspace-commands",
      "allow",
      "conv-xyz",
      "--json",
    ]);
    expect(code).toBe(0);
    expect(lastIpcCall?.method).toBe(
      "conversation_workspace_commands_set_cli",
    );
    expect(lastIpcCall?.params).toEqual({
      body: { conversationId: "conv-xyz", enabled: true },
    });
    expect(JSON.parse(loggerCalls[loggerCalls.length - 1]!.msg)).toEqual({
      ok: true,
      conversationId: "conv-xyz",
      enabled: true,
    });
  });

  test("get can resolve a Slack user", async () => {
    mockIpcResult = {
      ok: true,
      result: { conversationId: "conv-xyz", enabled: false },
    };
    const code = await run([
      "workspace-commands",
      "get",
      "--slack-user",
      "U12345678",
      "--json",
    ]);
    expect(code).toBe(0);
    expect(lastIpcCall?.method).toBe(
      "conversation_workspace_commands_get_cli",
    );
    expect(lastIpcCall?.params).toEqual({
      body: { slackUserId: "U12345678" },
    });
  });

  test("deny without a target exits non-zero before IPC", async () => {
    const code = await run(["workspace-commands", "deny", "--json"]);
    expect(code).toBe(1);
    expect(lastIpcCall).toBeNull();
    expect(JSON.parse(loggerCalls[loggerCalls.length - 1]!.msg)).toMatchObject({
      ok: false,
    });
  });
});
