/**
 * Tests for workspace migration `075-memory-v2-bm25-b-default-reembed`.
 *
 * The migration enqueues a one-shot `memory_v2_reembed` job so existing
 * concept pages pick up the new `bm25_b` default. It must be gated on
 * `memory.v2.enabled` so v1-only workspaces don't run an unnecessary pass.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("enqueues memory_v2_reembed when config.json is absent (v2 enabled by default)", () => {
    memoryV2Bm25BDefaultReembedMigration.run(workspaceDir);
    expect(countReembedJobs()).toBe(1);
  });

  test("enqueues memory_v2_reembed when memory.v2.enabled is explicitly true", () => {
    writeFileSync(
      join(workspaceDir, "config.json"),
      JSON.stringify({ memory: { v2: { enabled: true } } }),
      "utf-8",
    );
    memoryV2Bm25BDefaultReembedMigration.run(workspaceDir);
    expect(countReembedJobs()).toBe(1);
  });

  test("skips enqueue when memory.v2.enabled is explicitly false", () => {
    writeFileSync(
      join(workspaceDir, "config.json"),
      JSON.stringify({ memory: { v2: { enabled: false } } }),
      "utf-8",
    );
    memoryV2Bm25BDefaultReembedMigration.run(workspaceDir);
    expect(countReembedJobs()).toBe(0);
  });

  test("enqueues when config.json is malformed (falls back to default-enabled)", () => {
    writeFileSync(
      join(workspaceDir, "config.json"),
      "{not valid json",
      "utf-8",
    );
    memoryV2Bm25BDefaultReembedMigration.run(workspaceDir);
    expect(countReembedJobs()).toBe(1);
  });
});
