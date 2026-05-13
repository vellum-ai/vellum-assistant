/**
 * Tests for workspace migration `075-memory-v2-bm25-b-default-reembed`.
 *
 * The migration enqueues a one-shot `memory_v2_reembed` job so existing
 * concept pages pick up the new `bm25_b` default. It is gated on whether
 * the workspace already has concept pages on disk so a workspace that
 * disabled v2 (but kept its pages) still gets the queued reembed when v2
 * is re-enabled later.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { memoryV2Bm25BDefaultReembedMigration } from "../workspace/migrations/075-memory-v2-bm25-b-default-reembed.js";

let workspaceDir: string;
let dbPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-075-test-"));
  const dbDir = join(workspaceDir, "data", "db");
  mkdirSync(dbDir, { recursive: true });
  dbPath = join(dbDir, "assistant.db");

  const db = new Database(dbPath);
  db.run(`
    CREATE TABLE memory_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      deferrals INTEGER NOT NULL,
      run_after INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.close();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function seedConceptPage(relativePath: string): void {
  const fullPath = join(workspaceDir, "memory", "concepts", relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, "---\nedges: []\n---\nbody\n", "utf-8");
}

function countReembedJobs(): number {
  const db = new Database(dbPath);
  try {
    const row = db
      .query(
        `SELECT COUNT(*) AS n FROM memory_jobs WHERE type='memory_v2_reembed'`,
      )
      .get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

describe("075-memory-v2-bm25-b-default-reembed migration", () => {
  test("skips enqueue when memory/concepts/ does not exist", () => {
    memoryV2Bm25BDefaultReembedMigration.run(workspaceDir);
    expect(countReembedJobs()).toBe(0);
  });

  test("skips enqueue when memory/concepts/ is empty", () => {
    mkdirSync(join(workspaceDir, "memory", "concepts"), { recursive: true });
    memoryV2Bm25BDefaultReembedMigration.run(workspaceDir);
    expect(countReembedJobs()).toBe(0);
  });

  test("enqueues when a top-level concept page exists", () => {
    seedConceptPage("alice.md");
    memoryV2Bm25BDefaultReembedMigration.run(workspaceDir);
    expect(countReembedJobs()).toBe(1);
  });

  test("enqueues when only a nested concept page exists", () => {
    seedConceptPage("people/alice.md");
    memoryV2Bm25BDefaultReembedMigration.run(workspaceDir);
    expect(countReembedJobs()).toBe(1);
  });

  test("enqueues even when memory.v2.enabled is explicitly false (pages may be reembedded once v2 is re-enabled)", () => {
    seedConceptPage("alice.md");
    writeFileSync(
      join(workspaceDir, "config.json"),
      JSON.stringify({ memory: { v2: { enabled: false } } }),
      "utf-8",
    );
    memoryV2Bm25BDefaultReembedMigration.run(workspaceDir);
    expect(countReembedJobs()).toBe(1);
  });

  test("does not duplicate when a pending reembed job already exists", () => {
    seedConceptPage("alice.md");
    const db = new Database(dbPath);
    db.run(
      `INSERT INTO memory_jobs
         (id, type, payload, status, attempts, deferrals, run_after, last_error, created_at, updated_at)
       VALUES ('pre-existing', 'memory_v2_reembed', '{}', 'pending', 0, 0, 0, NULL, 0, 0)`,
    );
    db.close();
    memoryV2Bm25BDefaultReembedMigration.run(workspaceDir);
    expect(countReembedJobs()).toBe(1);
  });
});
