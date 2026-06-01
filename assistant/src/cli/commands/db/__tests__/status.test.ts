/**
 * Tests for `assistant db status`.
 *
 * Uses a real bun:sqlite database in a tmp dir rather than mocking, because
 * the whole point of the command is the SQL it issues (page-count pragma,
 * `memory_checkpoints` lookup, COUNT(*) fallback). Mocks would just
 * re-state the implementation.
 *
 * The command's only external dependency is `getDbPath()`, which derives
 * from `VELLUM_WORKSPACE_DIR` — we set that env var per test and let the
 * real platform helper produce the path. No module-level mocks needed.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test workspace setup
// ---------------------------------------------------------------------------

let workspaceDir: string;
let dbPath: string;
let originalWorkspaceEnv: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "db-status-test-"));
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

/** Build a minimal but realistic DB: WAL mode, a couple of tables with rows. */
function seedDb(): void {
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(`
      CREATE TABLE memory_checkpoints (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        content TEXT
      );
      CREATE TABLE small (
        id TEXT PRIMARY KEY
      );
    `);
    // 100 messages, 5 small
    const insertMsg = db.prepare(
      "INSERT INTO messages (id, content) VALUES (?, ?)",
    );
    for (let i = 0; i < 100; i++) {
      insertMsg.run(`m-${i}`, `row ${i}`);
    }
    const insertSmall = db.prepare("INSERT INTO small (id) VALUES (?)");
    for (let i = 0; i < 5; i++) {
      insertSmall.run(`s-${i}`);
    }
    // Two migration rows — only the later one matters.
    const insertCk = db.prepare(
      "INSERT INTO memory_checkpoints (key, value, updated_at) VALUES (?, ?, ?)",
    );
    insertCk.run("migration_older_v1", "1", 1_700_000_000_000);
    insertCk.run("migration_newest_v1", "1", 1_700_000_001_000);
    // A 'started' (not completed) row that must be IGNORED.
    insertCk.run("migration_running_v1", "started", 1_700_000_002_000);
  } finally {
    db.close();
  }
}

/** Run `assistant db status` with the given args, capturing stdio + exit. */
async function runStatus(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let exitCode = 0;

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalExit = process.exit;

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

  // process.exit is captured by throwing — the command finishes its work
  // before exiting, so the throw cleanly unwinds back here.
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
      if ((e as Error).message !== "__test_exit__") {
        throw e;
      }
    }
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
  }

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant db status — happy path", () => {
  test("reports path, sizes, table count, and largest tables", async () => {
    seedDb();

    const { stdout, stderr, exitCode } = await runStatus(["status"]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(dbPath);
    expect(stdout).toContain("Tables");
    expect(stdout).toMatch(/Tables\s+3/);
    // Largest by row count — `messages` (100) leads, `small` (5) trails.
    // (memory_checkpoints has 3 rows.)
    expect(stdout).toContain("Largest tables");
    expect(stdout.indexOf("messages")).toBeLessThan(stdout.indexOf("small"));
  });

  test("reports the latest 'completed' migration, ignoring 'started'", async () => {
    seedDb();

    const { stdout } = await runStatus(["status"]);

    // The 'started' row is more recent but value != '1', so the
    // completed row before it wins.
    expect(stdout).toContain("newest_v1");
    expect(stdout).not.toContain("running_v1");
  });

  test("reports WAL journal mode after seeding with WAL", async () => {
    seedDb();

    const { stdout } = await runStatus(["status"]);

    expect(stdout).toMatch(/Journal\s+wal/);
  });

  test("--json emits a single-line JSON object with the expected shape", async () => {
    seedDb();

    const { stdout, exitCode } = await runStatus(["--json", "status"]);

    expect(exitCode).toBe(0);
    // One line of JSON, parses cleanly.
    expect(stdout.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.file.exists).toBe(true);
    expect(parsed.file.path).toBe(dbPath);
    expect(parsed.db.journalMode).toBe("wal");
    expect(parsed.db.tableCount).toBe(3);
    expect(parsed.db.latestMigration.key).toBe("migration_newest_v1");
    expect(Array.isArray(parsed.db.largest)).toBe(true);
    expect(parsed.db.largest.length).toBeGreaterThan(0);
    // Either 'bytes' (if dbstat is available) or 'rows' fallback.
    expect(["bytes", "rows"]).toContain(parsed.db.sizingMethod);
  });
});

describe("assistant db status — DB missing", () => {
  test("exits 1 with a loud error and recovery hint", async () => {
    // No seedDb() — file simply does not exist.
    const { stdout, stderr, exitCode } = await runStatus(["status"]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("ERROR");
    expect(stderr).toContain("Database not found");
    expect(stderr).toContain(dbPath);
    // Should point the user at recovery channels.
    expect(stderr).toContain("assistant backup list");
  });

  test("--json missing DB emits structured payload and exits 1", async () => {
    const { stdout, stderr, exitCode } = await runStatus(["--json", "status"]);

    expect(exitCode).toBe(1);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed.file.exists).toBe(false);
    expect(parsed.db).toBeNull();
  });
});

describe("assistant db status — DB without memory_checkpoints", () => {
  test("reports schema unknown without crashing", async () => {
    // Create a DB that has zero application tables — exercises the
    // best-effort 'memory_checkpoints does not exist' branch.
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.close();

    const { stdout, exitCode } = await runStatus(["status"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Schema (last)");
    expect(stdout).toContain("unknown");
  });
});
