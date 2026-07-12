/**
 * Tests for the `assistant memory worker` CLI subgroup.
 *
 * The subgroup is a thin IPC client over the daemon's memory-worker status
 * route, so these validate:
 *   - Subcommand registration (status) under `memory worker`.
 *   - `status` calls exactly one IPC method and renders its response (`--json`
 *     emits the raw route payload).
 *   - IPC failures surface a non-zero exit.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

import { applyCommandHelp } from "../../../lib/cli-command-help.js";
import { memoryHelp } from "../index.help.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let ipcCalls: string[] = [];
const responses = new Map<
  string,
  { ok: boolean; result?: unknown; error?: string }
>();
let logOutput: string[] = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string) => {
    ipcCalls.push(method);
    return responses.get(method) ?? { ok: true, result: {} };
  },
  exitFromIpcResult: (r: { error?: string }) => {
    process.stderr.write((r.error ?? "error") + "\n");
    process.exitCode = 1;
  },
}));

const capture = (...args: unknown[]) => {
  logOutput.push(args.map(String).join(" "));
};
mock.module("../../../../util/logger.js", () => ({
  getLogger: () => ({
    info: capture,
    warn: capture,
    error: capture,
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: capture,
    warn: capture,
    error: capture,
    debug: () => {},
  }),
}));

const { registerMemoryWorkerCommand } = await import("../worker.js");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  const memory = program.command("memory");
  applyCommandHelp(memory, memoryHelp);
  registerMemoryWorkerCommand(memory);
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
    await buildProgram().parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  return { exitCode, stdout: stdoutChunks.join("") };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  ipcCalls = [];
  logOutput = [];
  responses.clear();
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("subcommand registration", () => {
  test("registers worker under memory with status", () => {
    const program = buildProgram();
    const memory = program.commands.find((c) => c.name() === "memory");
    const worker = memory!.commands.find((c) => c.name() === "worker");
    expect(worker).toBeDefined();
    expect(worker!.commands.map((c) => c.name()).sort()).toEqual(["status"]);
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("memory worker status", () => {
  test("calls memory_worker_status and renders the running PID", async () => {
    responses.set("memory_worker_status", {
      ok: true,
      result: {
        status: "running",
        pid: 321,
        embedding: {
          enabled: true,
          degraded: false,
          provider: "local",
          model: "Xenova/all-MiniLM-L6-v2",
          reason: null,
        },
      },
    });

    const { exitCode } = await runCommand(["memory", "worker", "status"]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual(["memory_worker_status"]);
    expect(logOutput.join("\n")).toContain(
      "Memory worker process is running (PID 321)",
    );
  });

  test("emits the raw payload with --json", async () => {
    const result = {
      status: "running",
      pid: 321,
      embedding: {
        enabled: true,
        degraded: false,
        provider: "local",
        model: "Xenova/all-MiniLM-L6-v2",
        reason: null,
      },
    };
    responses.set("memory_worker_status", { ok: true, result });

    const { exitCode, stdout } = await runCommand([
      "memory",
      "worker",
      "status",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual(["memory_worker_status"]);
    expect(JSON.parse(stdout)).toEqual(result);
  });

  test("exits non-zero when the daemon reports a failure", async () => {
    responses.set("memory_worker_status", { ok: false, error: "ipc failed" });

    const { exitCode } = await runCommand(["memory", "worker", "status"]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toEqual(["memory_worker_status"]);
  });
});
