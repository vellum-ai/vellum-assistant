/**
 * Tests for the `assistant memory worker` CLI subgroup.
 *
 * Validates:
 *   - Subcommand registration (start, stop, status) under `memory worker`.
 *   - `status` reports the worker process state, `memory.worker.enabled`, and
 *     the synchronous in-process runner via PID/marker-file liveness.
 *   - `stop` sends SIGTERM to a live worker and disables the config flag, and
 *     still disables the flag (success) when no worker is running.
 *   - `start` spawns/reuses the worker process and enables the config flag.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let tmpDir: string;
let pidPath: string;
let markerPath: string;
let logOutput: string[] = [];

/** In-memory stand-in for the on-disk raw config the CLI reads/writes. */
let rawConfig: Record<string, unknown> = {};

/** Records (pid, signal) pairs passed to the mocked process.kill. */
let killCalls: Array<{ pid: number; signal: string | number }> = [];

function workerEnabledFromRaw(): boolean {
  const memory = rawConfig.memory as { worker?: { enabled?: unknown } };
  return memory?.worker?.enabled === true;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../../util/platform.js", () => ({
  getMemoryWorkerPidPath: () => pidPath,
  getMemorySyncRunnerMarkerPath: () => markerPath,
}));

mock.module("../../../../config/loader.js", () => ({
  loadRawConfig: () => structuredClone(rawConfig),
  saveRawConfig: (config: Record<string, unknown>) => {
    rawConfig = structuredClone(config);
  },
  getConfigReadOnly: () => ({
    memory: { worker: { enabled: workerEnabledFromRaw() } },
  }),
  setNestedValue: (
    obj: Record<string, unknown>,
    path: string,
    value: unknown,
  ) => {
    const keys = path.split(".");
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
      cur = cur[k] as Record<string, unknown>;
    }
    cur[keys[keys.length - 1]] = value;
  },
}));

const capture = (...args: unknown[]) => {
  logOutput.push(args.map(String).join(" "));
};
const fakeLogger = {
  info: capture,
  warn: capture,
  error: capture,
  debug: () => {},
};
mock.module("../../../../util/logger.js", () => ({
  getLogger: () => fakeLogger,
  getCliLogger: () => fakeLogger,
  getCurrentLogFilePath: () => `${tmpDir}/assistant-test-mock.log`,
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerMemoryWorkerCommand } = await import("../worker.js");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => {},
    writeOut: () => {},
  });
  const memory = program.command("memory");
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
    const program = buildProgram();
    await program.parseAsync(["node", "assistant", ...args]);
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

/**
 * Replace process.kill with a recording stub. `signal 0` is the liveness
 * probe: it resolves for `livePids` and throws ESRCH otherwise. Other signals
 * are recorded and no-oped so the test runner is never actually signalled.
 */
function stubProcessKill(livePids: Set<number>): () => void {
  const original = process.kill.bind(process);
  killCalls = [];
  process.kill = ((pid: number, signal?: string | number) => {
    const sig = signal ?? 0;
    if (sig === 0) {
      if (livePids.has(pid)) return true;
      const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }
    killCalls.push({ pid, signal: sig });
    return true;
  }) as typeof process.kill;
  return () => {
    process.kill = original;
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-worker-test-"));
  pidPath = join(tmpDir, "memory-worker.pid");
  markerPath = join(tmpDir, "memory-sync-runner.pid");
  logOutput = [];
  killCalls = [];
  rawConfig = {};
  process.exitCode = 0;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Subcommand registration
// ---------------------------------------------------------------------------

describe("subcommand registration", () => {
  test("registers worker under memory with start/stop/status", () => {
    const program = buildProgram();
    const memory = program.commands.find((c) => c.name() === "memory");
    expect(memory).toBeDefined();
    const worker = memory!.commands.find((c) => c.name() === "worker");
    expect(worker).toBeDefined();
    const subcommandNames = worker!.commands.map((c) => c.name()).sort();
    expect(subcommandNames).toEqual(["start", "status", "stop"]);
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("memory worker status", () => {
  test("reports not_running with workerEnabled and syncRunner when nothing is running", async () => {
    const { exitCode, stdout } = await runCommand([
      "memory",
      "worker",
      "status",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      status: "not_running",
      workerEnabled: false,
      syncRunner: { status: "not_running" },
    });
  });

  test("reports running when PID file points at a live process", async () => {
    writeFileSync(pidPath, String(process.pid));
    const restore = stubProcessKill(new Set([process.pid]));
    try {
      const { exitCode, stdout } = await runCommand([
        "memory",
        "worker",
        "status",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        status: "running",
        pid: process.pid,
        workerEnabled: false,
        syncRunner: { status: "not_running" },
      });
    } finally {
      restore();
    }
  });

  test("reflects memory.worker.enabled from config", async () => {
    rawConfig = { memory: { worker: { enabled: true } } };
    const restore = stubProcessKill(new Set());
    try {
      const { exitCode, stdout } = await runCommand([
        "memory",
        "worker",
        "status",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ workerEnabled: true });
    } finally {
      restore();
    }
  });

  test("reports the synchronous runner as running when its marker is live", async () => {
    writeFileSync(markerPath, String(process.pid));
    const restore = stubProcessKill(new Set([process.pid]));
    try {
      const { exitCode, stdout } = await runCommand([
        "memory",
        "worker",
        "status",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        status: "not_running",
        syncRunner: { status: "running", pid: process.pid },
      });
    } finally {
      restore();
    }
  });

  test("treats a stale PID file as not_running and cleans it up", async () => {
    writeFileSync(pidPath, "999999");
    const restore = stubProcessKill(new Set());
    try {
      const { exitCode, stdout } = await runCommand([
        "memory",
        "worker",
        "status",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        status: "not_running",
        workerEnabled: false,
        syncRunner: { status: "not_running" },
      });
      expect(existsSync(pidPath)).toBe(false);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe("memory worker stop", () => {
  test("disables the config flag and succeeds when no worker is running", async () => {
    rawConfig = { memory: { worker: { enabled: true } } };
    const { exitCode, stdout } = await runCommand([
      "memory",
      "worker",
      "stop",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      workerWasRunning: false,
      workerEnabled: false,
    });
    expect(workerEnabledFromRaw()).toBe(false);
  });

  test("sends SIGTERM to a running worker and disables the flag", async () => {
    rawConfig = { memory: { worker: { enabled: true } } };
    writeFileSync(pidPath, String(process.pid));
    const restore = stubProcessKill(new Set([process.pid]));
    try {
      const { exitCode, stdout } = await runCommand([
        "memory",
        "worker",
        "stop",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        ok: true,
        pid: process.pid,
        workerEnabled: false,
      });
      expect(killCalls).toContainEqual({
        pid: process.pid,
        signal: "SIGTERM",
      });
      expect(workerEnabledFromRaw()).toBe(false);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

describe("memory worker start", () => {
  test("reuses an already-running worker and enables the flag", async () => {
    writeFileSync(pidPath, String(process.pid));
    const restore = stubProcessKill(new Set([process.pid]));
    try {
      const { exitCode, stdout } = await runCommand([
        "memory",
        "worker",
        "start",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        pid: process.pid,
        alreadyRunning: true,
        workerEnabled: true,
      });
      expect(workerEnabledFromRaw()).toBe(true);
    } finally {
      restore();
    }
  });

  test("spawns the worker, reports its PID, and enables the flag", async () => {
    const restore = stubProcessKill(new Set());
    const originalSpawn = Bun.spawn;
    // Simulate the spawned worker writing its PID file on startup.
    (Bun as { spawn: typeof Bun.spawn }).spawn = (() => {
      writeFileSync(pidPath, "424242");
      return { unref: () => {}, pid: 424242 };
    }) as unknown as typeof Bun.spawn;
    try {
      const { exitCode, stdout } = await runCommand([
        "memory",
        "worker",
        "start",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        pid: 424242,
        workerEnabled: true,
      });
      expect(workerEnabledFromRaw()).toBe(true);
    } finally {
      (Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
      restore();
    }
  });

  test("leaves the config flag untouched when the spawn fails", async () => {
    const restore = stubProcessKill(new Set());
    const originalSpawn = Bun.spawn;
    // Spawn returns a child that exits during startup without writing a PID file
    // → spawnMemoryWorkerProcess detects the early exit and throws, so the flag
    // must stay disabled.
    (Bun as { spawn: typeof Bun.spawn }).spawn = (() => ({
      unref: () => {},
      kill: () => {},
      exited: Promise.resolve(1),
      pid: 123,
    })) as unknown as typeof Bun.spawn;
    try {
      const { exitCode, stdout } = await runCommand([
        "memory",
        "worker",
        "start",
        "--json",
      ]);
      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({ ok: false });
      expect(workerEnabledFromRaw()).toBe(false);
    } finally {
      (Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
      restore();
    }
  });
});
