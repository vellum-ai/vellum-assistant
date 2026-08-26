/**
 * Tests for `assistant contacts set-threshold`.
 *
 * Uses the IPC mock pattern: cliIpcCall is stubbed so tests assert the
 * CLI surface (flags, inherit mapping, output) without a running assistant.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

let lastIpcCall: {
  method: string;
  params?: Record<string, unknown>;
} | null = null;

let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
} = {
  ok: true,
  result: { ok: true, contactId: "contact-1", threshold: "high" },
};

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
  exitFromIpcResult: (r: { ok: false; error?: string }) => {
    process.stderr.write((r.error ?? "Unknown error") + "\n");
    process.exitCode = 1;
    return undefined as never;
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

const { registerContactsCommand } = await import("../contacts.js");

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
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerContactsCommand(program);
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

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = {
    ok: true,
    result: { ok: true, contactId: "contact-1", threshold: "high" },
  };
  process.exitCode = 0;
});

describe("contacts set-threshold", () => {
  test("registers set-threshold under contacts", () => {
    const program = new Command();
    registerContactsCommand(program);
    const contacts = program.commands.find((c) => c.name() === "contacts");
    expect(contacts).toBeDefined();
    expect(contacts!.commands.map((c) => c.name())).toContain("set-threshold");
  });

  test("sends a ceiling write over IPC", async () => {
    const { exitCode, stdout } = await runCommand([
      "contacts",
      "set-threshold",
      "contact-1",
      "--threshold",
      "high",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toEqual({
      method: "set_contact_threshold",
      params: {
        body: { contactId: "contact-1", threshold: "high" },
      },
    });
    expect(stdout).toContain("Set assistant access for contact-1 to high");
  });

  test("maps inherit to a null ceiling", async () => {
    mockIpcResult = {
      ok: true,
      result: { ok: true, contactId: "contact-1", threshold: null },
    };

    const { exitCode, stdout } = await runCommand([
      "contacts",
      "set-threshold",
      "contact-1",
      "--threshold",
      "inherit",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall?.params).toEqual({
      body: { contactId: "contact-1", threshold: null },
    });
    expect(stdout).toContain("Set assistant access for contact-1 to inherit");
  });

  test("rejects an unknown threshold without calling IPC", async () => {
    const { exitCode } = await runCommand([
      "contacts",
      "set-threshold",
      "contact-1",
      "--threshold",
      "full",
    ]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("exits 1 when the assistant is unreachable", async () => {
    mockIpcResult = { ok: false, error: "assistant is not running" };

    const { exitCode } = await runCommand([
      "contacts",
      "set-threshold",
      "contact-1",
      "--threshold",
      "high",
    ]);

    expect(exitCode).toBe(1);
  });
});
