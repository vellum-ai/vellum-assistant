/**
 * Tests for the `assistant memory worker` CLI subgroup.
 *
 * The subgroup is a thin IPC client over the daemon's memory-worker routes, so
 * these validate:
 *   - Subcommand registration (start, stop, status) under `memory worker`.
 *   - Each subcommand calls exactly one IPC method and renders its response
 *     (`--json` emits the raw route payload).
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
  test("registers worker under memory with start/stop/status", () => {
    const program = buildProgram();
    const memory = program.commands.find((c) => c.name() === "memory");
    const worker = memory!.commands.find((c) => c.name() === "worker");
    expect(worker).toBeDefined();
    expect(worker!.commands.map((c) => c.name()).sort()).toEqual([
      "start",
      "status",
      "stop",
    ]);
  });
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

describe("memory worker start", () => {
  test("calls memory_worker_start and renders the PID", async () => {
    responses.set("memory_worker_start", {
      ok: true,
      result: {
        pid: 4242,
        alreadyRunning: false,
        pidPath: "/x/memory-worker.pid",
      },
    });

    const { exitCode } = await runCommand(["memory", "worker", "start"]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual(["memory_worker_start"]);
    expect(logOutput.join("\n")).toContain("Memory worker started (PID 4242)");
  });

  test("--json emits the raw route payload", async () => {
    const result = {
      pid: 7,
      alreadyRunning: true,
      pidPath: "/x/p.pid",
    };
    responses.set("memory_worker_start", { ok: true, result });

    const { exitCode, stdout } = await runCommand([
      "memory",
      "worker",
      "start",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(result);
  });

  test("exits non-zero when the daemon reports a spawn failure", async () => {
    responses.set("memory_worker_start", { ok: false, error: "spawn failed" });

    const { exitCode } = await runCommand(["memory", "worker", "start"]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toEqual(["memory_worker_start"]);
  });
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe("memory worker stop", () => {
  test("calls memory_worker_stop and renders the signalled PID", async () => {
    responses.set("memory_worker_stop", {
      ok: true,
      result: { workerWasRunning: true, pid: 555 },
    });

    const { exitCode } = await runCommand(["memory", "worker", "stop"]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual(["memory_worker_stop"]);
    expect(logOutput.join("\n")).toContain(
      "Memory worker stop signal sent (PID 555)",
    );
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("memory worker status", () => {
  test("calls memory_worker_status and emits the raw payload with --json", async () => {
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
});
