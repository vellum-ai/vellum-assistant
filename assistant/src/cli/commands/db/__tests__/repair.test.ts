/**
 * Tests for `assistant db repair`.
 *
 * Covers:
 *   - integrity check passes on a healthy DB (happy path)
 *   - integrity check reports errors on a deliberately corrupted DB
 *   - missing DB exits 1 with a loud error
 *   - --json shape contains step results
 *   - the step framework itself (continue-on-error, halt-on-error, throwing
 *     step captured as a synthetic error result)
 *
 * Uses real bun:sqlite databases in tmp dirs; the integrity check needs to
 * walk actual pages, so mocking would defeat the point.
 */

import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { RepairStep } from "../repair-steps.js";
import { runRepairSteps } from "../repair-steps.js";

// ---------------------------------------------------------------------------
// Workspace setup
// ---------------------------------------------------------------------------

let workspaceDir: string;
let dbPath: string;
let originalWorkspaceEnv: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "db-repair-test-"));
  mkdirSync(join(workspaceDir, "data", "db"), { recursive: true });
  dbPath = join(workspaceDir, "data", "db", "assistant.db");
  originalWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
});

afterEach(() => {
  if (originalWorkspaceEnv === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceEnv;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedHealthyDb(opts: { walMode?: boolean } = {}): void {
  const db = new Database(dbPath);
  try {
    // Default to WAL to match production. The corrupt-DB seed disables
    // WAL so it can trample the main file directly (otherwise data lives
    // in the -wal file and the main file is just a 1-page header).
    if (opts.walMode ?? true) {
      db.exec("PRAGMA journal_mode=WAL");
    } else {
      db.exec("PRAGMA journal_mode=DELETE");
    }
    db.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT);
    `);
    const ins = db.prepare(
      "INSERT INTO conversations (id, title) VALUES (?, ?)",
    );
    for (let i = 0; i < 50; i++) ins.run(`c-${i}`, `t-${i}`);
  } finally {
    db.close();
  }
}

/**
 * Build a structurally invalid SQLite file by writing junk bytes over a
 * b-tree page in an otherwise-formed DB. PRAGMA integrity_check rejects
 * this with concrete error rows.
 *
 * Uses rollback-journal mode (not WAL) so all data lives in the main
 * file — otherwise the main file is just a 1-page header and our writes
 * land in unused space the integrity check doesn't validate.
 */
function seedCorruptDb(): void {
  seedHealthyDb({ walMode: false });
  const fd = openSync(dbPath, "r+");
  try {
    const junk = Buffer.alloc(32 * 1024, 0xff);
    // Start at page 2 (header is page 1); the data b-tree pages live in
    // the next few pages of a small healthy DB.
    writeSync(fd, junk, 0, junk.length, 1 * 4096);
  } finally {
    closeSync(fd);
  }
}

async function runRepair(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let exitCode = 0;

  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__test_exit__");
  }) as typeof process.exit;

  try {
    const { Command } = await import("commander");
    const { registerDbCommand } = await import("../index.js");
    const program = new Command();
    program.exitOverride();
    registerDbCommand(program);
    try {
      await program.parseAsync(["node", "assistant", "db", ...args]);
    } catch (e) {
      if ((e as Error).message !== "__test_exit__") throw e;
    }
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exit = origExit;
  }
  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// Integrity check — DB level
// ---------------------------------------------------------------------------

describe("assistant db repair — healthy DB", () => {
  test("integrity check passes and exits 0", async () => {
    seedHealthyDb();
    const { stdout, exitCode } = await runRepair(["repair"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("integrity-check");
    expect(stdout).toContain("ok");
    expect(stdout).toContain("no corruption detected");
    expect(stdout).toMatch(/Done\. 1 step ran: 1 ok, 0 failed/);
  });

  test("--json emits a structured report with the step result", async () => {
    seedHealthyDb();
    const { stdout, exitCode } = await runRepair(["--json", "repair"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.dbPath).toBe(dbPath);
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0].name).toBe("integrity-check");
    expect(parsed.steps[0].result.status).toBe("ok");
    expect(parsed.steps[0].result.data.errorCount).toBe(0);
    expect(typeof parsed.steps[0].result.durationMs).toBe("number");
    expect(parsed.okCount).toBe(1);
    expect(parsed.errorCount).toBe(0);
  });
});

describe("assistant db repair — corrupt DB", () => {
  test("integrity check surfaces corruption and exits 1", async () => {
    seedCorruptDb();
    const { stdout, exitCode } = await runRepair(["repair"]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("integrity-check");
    expect(stdout).toContain("error");
    // The seed produces a severely-corrupt DB where PRAGMA integrity_check
    // itself throws "database disk image is malformed" before yielding any
    // rows. The step normalizes that into a structured corruption signal
    // rather than letting the runner mark it as a synthetic bug.
    expect(stdout).toMatch(
      /(integrity violation|database is too corrupt|database disk image is malformed)/,
    );
    expect(stdout).not.toContain("this is a bug");
    expect(stdout).toMatch(/Done\. 1 step ran: 0 ok, 1 failed/);
  });

  test("--json carries the full error list", async () => {
    seedCorruptDb();
    const { stdout, exitCode } = await runRepair(["--json", "repair"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.steps[0].result.status).toBe("error");
    expect(parsed.steps[0].result.data).toBeDefined();
    expect(Array.isArray(parsed.steps[0].result.data.errors)).toBe(true);
    expect(parsed.steps[0].result.data.errors.length).toBeGreaterThan(0);
    expect(parsed.errorCount).toBe(1);
  });
});

describe("assistant db repair — DB missing", () => {
  test("exits 1 with a loud error", async () => {
    // No seed
    const { stdout, stderr, exitCode } = await runRepair(["repair"]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("ERROR");
    expect(stderr).toContain("Database not found");
    expect(stderr).toContain(dbPath);
  });

  test("--json missing DB emits structured payload, exits 1", async () => {
    const { stdout, exitCode } = await runRepair(["--json", "repair"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.missing).toBe(true);
    expect(parsed.dbPath).toBe(dbPath);
    expect(parsed.steps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Step framework — runner semantics
// ---------------------------------------------------------------------------

describe("repair step runner", () => {
  test("runs steps sequentially in declared order", async () => {
    const calls: string[] = [];
    const steps: RepairStep[] = [
      {
        name: "a",
        description: "first",
        run: async () => {
          calls.push("a");
          return { status: "ok", summary: "" };
        },
      },
      {
        name: "b",
        description: "second",
        run: async () => {
          calls.push("b");
          return { status: "ok", summary: "" };
        },
      },
    ];
    const report = await runRepairSteps({ dbPath }, steps);
    expect(calls).toEqual(["a", "b"]);
    expect(report.okCount).toBe(2);
    expect(report.errorCount).toBe(0);
  });

  test("continues to the next step on non-halting failure", async () => {
    const calls: string[] = [];
    const steps: RepairStep[] = [
      {
        name: "broken",
        description: "fails but does not halt",
        run: async () => {
          calls.push("broken");
          return { status: "error", summary: "boom" };
        },
      },
      {
        name: "later",
        description: "still runs",
        run: async () => {
          calls.push("later");
          return { status: "ok", summary: "" };
        },
      },
    ];
    const report = await runRepairSteps({ dbPath }, steps);
    expect(calls).toEqual(["broken", "later"]);
    expect(report.errorCount).toBe(1);
    expect(report.okCount).toBe(1);
    expect(report.halted).toBe(false);
  });

  test("stops the sequence when a step reports halt: true", async () => {
    const calls: string[] = [];
    const steps: RepairStep[] = [
      {
        name: "fatal",
        description: "halts",
        run: async () => {
          calls.push("fatal");
          return { status: "error", summary: "stop now", halt: true };
        },
      },
      {
        name: "skipped",
        description: "never runs",
        run: async () => {
          calls.push("skipped");
          return { status: "ok", summary: "" };
        },
      },
    ];
    const report = await runRepairSteps({ dbPath }, steps);
    expect(calls).toEqual(["fatal"]);
    expect(report.halted).toBe(true);
    expect(report.steps).toHaveLength(1);
  });

  test("captures thrown errors as synthetic error results", async () => {
    const steps: RepairStep[] = [
      {
        name: "thrower",
        description: "throws unexpectedly",
        run: async () => {
          throw new Error("unhandled");
        },
      },
    ];
    const report = await runRepairSteps({ dbPath }, steps);
    expect(report.errorCount).toBe(1);
    expect(report.steps[0].result.status).toBe("error");
    const detail = report.steps[0].result.detailLines ?? [];
    expect(detail.join(" ")).toContain("bug");
  });

  test("records non-zero durationMs for each step", async () => {
    const steps: RepairStep[] = [
      {
        name: "timed",
        description: "noop",
        run: async () => ({ status: "ok", summary: "" }),
      },
    ];
    const report = await runRepairSteps({ dbPath }, steps);
    expect(report.steps[0].result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
