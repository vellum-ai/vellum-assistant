import * as nodeFs from "node:fs";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

let lastIpcCall: { method: string; params?: Record<string, unknown> } | null =
  null;
const stdoutChunks: string[] = [];

let mockIpcResult: { ok: boolean; result?: unknown; error?: string } = {
  ok: true,
  result: { contactId: "contact-abc", enabled: true },
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
    stdoutChunks.push(r.error ?? "Unknown error");
  },
}));

const fakeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
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

const { registerContactsCommand } = await import("../contacts.js");

async function run(args: string[]): Promise<number> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerContactsCommand(program);
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await program.parseAsync(["node", "assistant", "contacts", ...args]);
  } catch {
    if (process.exitCode === 0 || process.exitCode === undefined) {
      process.exitCode = 1;
    }
  } finally {
    process.stdout.write = originalWrite;
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return code;
}

beforeEach(() => {
  lastIpcCall = null;
  stdoutChunks.length = 0;
  process.exitCode = 0;
  mockIpcResult = {
    ok: true,
    result: { contactId: "contact-abc", enabled: true },
  };
});

afterEach(() => {
  process.exitCode = 0;
});

describe("contacts workspace-commands", () => {
  test("allow sends enabled true for a contact id", async () => {
    const code = await run([
      "--json",
      "workspace-commands",
      "allow",
      "contact-abc",
    ]);
    expect(code).toBe(0);
    expect(lastIpcCall?.method).toBe("contact_workspace_commands_set_cli");
    expect(lastIpcCall?.params).toEqual({
      body: { contactId: "contact-abc", enabled: true },
    });
    expect(JSON.parse(stdoutChunks.join(""))).toEqual({
      ok: true,
      contactId: "contact-abc",
      enabled: true,
    });
  });

  test("get reads the standing grant for a contact", async () => {
    mockIpcResult = {
      ok: true,
      result: { contactId: "contact-abc", enabled: false },
    };
    const code = await run([
      "--json",
      "workspace-commands",
      "get",
      "contact-abc",
    ]);
    expect(code).toBe(0);
    expect(lastIpcCall?.method).toBe("contact_workspace_commands_get_cli");
    expect(lastIpcCall?.params).toEqual({
      body: { contactId: "contact-abc" },
    });
  });

  test("deny without a contact id exits non-zero before IPC", async () => {
    const code = await run(["--json", "workspace-commands", "deny"]);
    expect(code).toBe(1);
    expect(lastIpcCall).toBeNull();
  });
});
