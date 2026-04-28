import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { parseDuration } from "../cli/commands/conversations-defer.js";

// ---------------------------------------------------------------------------
// Mocks for CLI command tests — declared before importing registerCommand
// ---------------------------------------------------------------------------

const logMessages: { level: string; msg: string }[] = [];

mock.module("../cli/logger.js", () => ({
  log: {
    info: (msg: string) => logMessages.push({ level: "info", msg }),
    warn: (msg: string) => logMessages.push({ level: "warn", msg }),
    error: (msg: string) => logMessages.push({ level: "error", msg }),
    debug: () => {},
  },
  getCliLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

mock.module("../ipc/cli-client.js", () => ({
  cliIpcCall: async () => ({ ok: true, result: { defers: [] } }),
}));

describe("parseDuration", () => {
  test("bare number treated as seconds", () => {
    expect(parseDuration("60")).toBe(60);
  });

  test("seconds suffix", () => {
    expect(parseDuration("60s")).toBe(60);
  });

  test("minutes suffix", () => {
    expect(parseDuration("5m")).toBe(300);
  });

  test("hours suffix", () => {
    expect(parseDuration("1h")).toBe(3600);
  });

  test("composite hours and minutes", () => {
    expect(parseDuration("1h30m")).toBe(5400);
  });

  test("seconds only with suffix", () => {
    expect(parseDuration("90s")).toBe(90);
  });

  test("throws on invalid string", () => {
    expect(() => parseDuration("invalid")).toThrow(
      'Invalid duration: "invalid"',
    );
  });

  test("throws on empty string", () => {
    expect(() => parseDuration("")).toThrow('Invalid duration: ""');
  });
});

// ---------------------------------------------------------------------------
// defer CLI option inheritance
// ---------------------------------------------------------------------------

import { Command } from "commander";

import { registerConversationsDeferCommand } from "../cli/commands/conversations-defer.js";

describe("defer CLI option inheritance", () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    logMessages.length = 0;
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  function makeProgram(): Command {
    const program = new Command();
    program.exitOverride(); // throw instead of calling process.exit
    const conversations = program.command("conversations");
    registerConversationsDeferCommand(conversations);
    return program;
  }

  test("list subcommand can be parsed without --hint", async () => {
    const program = makeProgram();
    await program.parseAsync([
      "node",
      "test",
      "conversations",
      "defer",
      "list",
    ]);
    // Should not set a failure exit code — the command parsed successfully
    expect(process.exitCode).not.toBe(1);
  });

  test("cancel subcommand can be parsed without --hint", async () => {
    const program = makeProgram();
    await program.parseAsync([
      "node",
      "test",
      "conversations",
      "defer",
      "cancel",
      "--all",
    ]);
    // Should not set a failure exit code — the command parsed successfully
    expect(process.exitCode).not.toBe(1);
  });

  test("create action errors when --hint is omitted", async () => {
    const program = makeProgram();
    // Provide --in so we get past the --in/--at check, but omit --hint
    // Also set a conversation ID env var so we get past that check
    const origConvId = process.env.__CONVERSATION_ID;
    process.env.__CONVERSATION_ID = "conv-test-123";
    try {
      await program.parseAsync([
        "node",
        "test",
        "conversations",
        "defer",
        "--in",
        "30s",
      ]);
      expect(process.exitCode).toBe(1);
      const errorMsg = logMessages.find((m) => m.level === "error");
      expect(errorMsg?.msg).toContain(
        "--hint is required when creating a deferred wake",
      );
    } finally {
      if (origConvId === undefined) {
        delete process.env.__CONVERSATION_ID;
      } else {
        process.env.__CONVERSATION_ID = origConvId;
      }
    }
  });
});
