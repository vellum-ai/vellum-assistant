/**
 * CLI plumbing tests for `assistant usage` (cli/commands/usage.ts).
 *
 * The `usage breakdown` subcommand is daemon-mediated via `cliIpcCall`; only
 * argument validation runs in the CLI process. Table formatting and
 * aggregation behavior are covered daemon-side in `usage-routes.test.ts`.
 *
 * Follow-up opportunity: mock `../ipc/cli-client.js` and assert CLI plumbing
 * (table formatting, --json output shape) against canned IPC responses.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

const logLines: string[] = [];

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: (message: string) => logLines.push(message),
    warn: (message: string) => logLines.push(message),
    error: (message: string) => logLines.push(message),
    debug: () => {},
  }),
}));

const { registerUsageCommand } = await import("../cli/commands/usage.js");

async function runCommand(args: string[]): Promise<{
  exitCode: number;
  output: string;
}> {
  process.exitCode = 0;
  logLines.length = 0;
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    process.exitCode = code ?? 0;
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit;

  try {
    const program = new Command();
    program.exitOverride();
    registerUsageCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.exit = originalExit;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  return { exitCode, output: logLines.join("\n") };
}

describe("assistant usage CLI", () => {
  beforeEach(() => {
    logLines.length = 0;
  });

  test("rejects invalid breakdown dimensions", async () => {
    const result = await runCommand([
      "usage",
      "breakdown",
      "--group-by",
      "invalid",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Invalid --group-by value");
    expect(result.output).toContain("call_site");
    expect(result.output).toContain("inference_profile");
  });
});
