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
  writeFileSync,
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
    expect(stdout).toContain("conversation-backfill");
    expect(stdout).toMatch(/Done\. 2 steps ran: 2 ok, 0 failed/);
  });

  test("--json emits a structured report with all step results", async () => {
    seedHealthyDb();
    const { stdout, exitCode } = await runRepair(["--json", "repair"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.dbPath).toBe(dbPath);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0].name).toBe("integrity-check");
    expect(parsed.steps[0].result.status).toBe("ok");
    expect(parsed.steps[0].result.data.errorCount).toBe(0);
    expect(typeof parsed.steps[0].result.durationMs).toBe("number");
    expect(parsed.steps[1].name).toBe("conversation-backfill");
    expect(parsed.steps[1].result.status).toBe("ok");
    expect(parsed.okCount).toBe(2);
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
    // Backfill still attempts to run after integrity check fails (continue
    // on non-halting error). On the rollback-journal-mode corrupt seed
    // backfill itself runs against an empty conversations dir and reports
    // "nothing to backfill", so the summary is `1 ok, 1 failed`.
    expect(stdout).toMatch(/Done\. 2 steps ran: 1 ok, 1 failed/);
  });

  test("--json carries the full error list from integrity-check", async () => {
    seedCorruptDb();
    const { stdout, exitCode } = await runRepair(["--json", "repair"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.steps[0].name).toBe("integrity-check");
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

// ---------------------------------------------------------------------------
// Integrity step — open failures
// ---------------------------------------------------------------------------

describe("integrity-check step — open failures", () => {
  test("file-is-a-directory surfaces as a structured error", async () => {
    // Make the db path itself a directory, so SQLite can't open it as a
    // file. The constructor throws; without our explicit catch the runner
    // would mark this as "this is a bug".
    rmSync(dbPath, { force: true });
    mkdirSync(dbPath, { recursive: true });

    const { stdout, exitCode } = await runRepair(["--json", "repair"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.steps[0].name).toBe("integrity-check");
    expect(parsed.steps[0].result.status).toBe("error");
    expect(parsed.steps[0].result.data.openFailed).toBe(true);
    expect(parsed.steps[0].result.summary).toContain("could not open");
    // Crucially: not flagged as a bug.
    const allDetail = JSON.stringify(parsed);
    expect(allDetail).not.toContain("this is a bug");
  });
});

// ---------------------------------------------------------------------------
// Conversation-backfill step
// ---------------------------------------------------------------------------

/**
 * Seed a `<workspace>/conversations/<id>/` directory pair on disk for the
 * backfill step to discover. Returns the conversation id used.
 */
function seedDiskConversation(
  opts: {
    id?: string;
    title?: string;
    messages?: Array<{ role: string; content: string; ts?: string }>;
  } = {},
): string {
  const id = opts.id ?? "conv-disk-1";
  const dir = join(workspaceDir, "conversations", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      id,
      title: opts.title ?? "Backfilled",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:01:00.000Z",
    }),
  );
  if (opts.messages) {
    const lines = opts.messages
      .map((m) =>
        JSON.stringify({ role: m.role, content: m.content, ts: m.ts }),
      )
      .join("\n");
    writeFileSync(join(dir, "messages.jsonl"), lines + "\n");
  }
  return id;
}

/** Apply the schema to the test DB so backfill has tables to insert into. */
async function initSchema(): Promise<void> {
  // The repair step opens its own bun:sqlite handle but expects the schema
  // to already exist (production-wise, the daemon creates it). Touching the
  // global init triggers schema creation against the env-isolated path.
  const { getDb, getSqliteFrom } =
    await import("../../../../persistence/db-connection.js");
  const { clearStoredDb } =
    await import("../../../../persistence/db-singleton.js");
  // Drop any connections a prior test (or test file) left open against a
  // now-deleted workspace, so init below opens fresh handles — main and the
  // dedicated logs/memory connections — at THIS test's workspace.
  clearStoredDb("main");
  clearStoredDb("logs");
  clearStoredDb("memory");

  const { initializeDb } = await import("../../../../persistence/db-init.js");
  await initializeDb();
  // Close the singletons so backfill can open its own handle without
  // collision. WAL allows concurrent handles but cleaner ownership avoids
  // test cross-talk through the in-process cache.
  try {
    getSqliteFrom(getDb()).close();
  } catch {
    /* already closed */
  }
  clearStoredDb("main");
  clearStoredDb("logs");
  clearStoredDb("memory");
}

// Every test here runs initSchema(), which replays the full production
// migration suite, plus at least one repair pass. On a loaded machine that
// comfortably exceeds bun's 5s per-test default, so each gets a 30s ceiling.
describe("assistant db repair — conversation-backfill step", () => {
  test("backfills a disk-only conversation into SQLite", async () => {
    await initSchema();
    seedDiskConversation({
      id: "conv-recover-1",
      title: "Recover me",
      messages: [
        { role: "user", content: "hi", ts: "2025-01-01T00:00:30.000Z" },
        { role: "assistant", content: "hello", ts: "2025-01-01T00:00:31.000Z" },
      ],
    });

    const { stdout, exitCode } = await runRepair(["--json", "repair"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    const backfill = parsed.steps[1];
    expect(backfill.name).toBe("conversation-backfill");
    expect(backfill.result.status).toBe("ok");
    expect(backfill.result.data.recovered).toBe(1);
    expect(backfill.result.data.errors).toBe(0);
    expect(backfill.result.data.skipped).toBe(0);

    // And confirm it actually landed in SQLite.
    const verify = new Database(dbPath, { readonly: true });
    try {
      const row = verify
        .query<
          { id: string; title: string },
          []
        >("SELECT id, title FROM conversations WHERE id = 'conv-recover-1'")
        .get();
      expect(row?.id).toBe("conv-recover-1");
      expect(row?.title).toBe("Recover me");
      const msgCount = verify
        .query<
          { n: number },
          []
        >("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = 'conv-recover-1'")
        .get();
      expect(msgCount?.n).toBe(2);
    } finally {
      verify.close();
    }
  }, 30_000);

  test("skips conversations already present (idempotent)", async () => {
    await initSchema();
    seedDiskConversation({ id: "conv-idempotent-1" });

    // First run: recover.
    let { stdout } = await runRepair(["--json", "repair"]);
    let parsed = JSON.parse(stdout);
    expect(parsed.steps[1].result.data.recovered).toBe(1);

    // Second run: should skip.
    ({ stdout } = await runRepair(["--json", "repair"]));
    parsed = JSON.parse(stdout);
    expect(parsed.steps[1].result.data.recovered).toBe(0);
    expect(parsed.steps[1].result.data.skipped).toBe(1);
    expect(parsed.steps[1].result.status).toBe("ok");
  }, 30_000);

  test("reports nothing-to-backfill on an empty conversations dir", async () => {
    await initSchema();
    // No seedDiskConversation call.
    const { stdout, exitCode } = await runRepair(["--json", "repair"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.steps[1].result.status).toBe("ok");
    expect(parsed.steps[1].result.summary).toContain("nothing to backfill");
    expect(parsed.steps[1].result.data.recovered).toBe(0);
  }, 30_000);

  test("surfaces warnings for malformed meta.json without erroring the step", async () => {
    await initSchema();
    const dir = join(workspaceDir, "conversations", "broken-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), "{ not valid json");

    const { stdout, exitCode } = await runRepair(["--json", "repair"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.steps[1].result.status).toBe("ok");
    expect(parsed.steps[1].result.data.skipped).toBe(1);
    expect(
      parsed.steps[1].result.data.warnings.some((w: string) =>
        w.includes("malformed meta.json"),
      ),
    ).toBe(true);
  }, 30_000);
});
