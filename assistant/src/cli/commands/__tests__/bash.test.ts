/**
 * Tests for `assistant bash`: local sanitized spawn, no IPC round-trip.
 */

import { describe, expect, mock, test } from "bun:test";

import { runCliCommand } from "./cli-test-harness.js";

const ipcCalls: Array<{ method: string }> = [];

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string) => {
    ipcCalls.push({ method });
    return { ok: false, error: "IPC should not be used" };
  },
}));

mock.module("../../logger.js", () => ({
  log: {
    info: () => {},
    warn: () => {},
    error: (message: string) => {
      process.stderr.write(`${message}\n`);
    },
    debug: () => {},
  },
}));

const { registerBashCommand } = await import("../bash.js");

describe("assistant bash", () => {
  test("spawns locally and prints stdout without IPC", async () => {
    ipcCalls.length = 0;
    const result = await runCliCommand(registerBashCommand, [
      "bash",
      "echo hello",
    ]);
    expect(ipcCalls).toEqual([]);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  test("rejects a non-positive timeout", async () => {
    const result = await runCliCommand(registerBashCommand, [
      "bash",
      "echo hello",
      "--timeout",
      "0",
    ]);
    expect(result.stderr).toContain("Invalid timeout value");
    expect(result.exitCode).toBe(1);
  });
});
