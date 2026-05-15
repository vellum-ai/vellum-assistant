/**
 * Tests for workspace migration
 * `085-memory-v2-bm25-b-reembed-disabled-v2-pages`.
 *
 * Re-enqueues `memory_v2_reembed` for workspaces with v2 concept pages,
 * gated on (a) concept pages existing on disk and (b) v2 not being
 * explicitly disabled in config.json. Migration 075 already shipped
 * un-gated, so this follow-up runs with the gating we want now.
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

import { memoryV2Bm25BReembedDisabledV2PagesMigration } from "../workspace/migrations/085-memory-v2-bm25-b-reembed-disabled-v2-pages.js";

let workspaceDir: string;
let dbPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-085-test-"));
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

function writeConfig(content: object): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(content),
    "utf-8",
  );
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

describe("085-memory-v2-bm25-b-reembed-disabled-v2-pages migration", () => {
  test("skips enqueue when memory/concepts/ does not exist", () => {
    memoryV2Bm25BReembedDisabledV2PagesMigration.run(workspaceDir);
    expect(countReembedJobs()).toBe(0);
  });

  test("skips enqueue when memory/concepts/ is empty", () => {
    mkdirSync(join(workspaceDir, "memory", "concepts"), { recursive: true });
    memoryV2Bm25BReembedDisabledV2PagesMigration.run(workspaceDir);
    expect(countReembedJobs()).toBe(0);
  });

  test("enqueues when a top-level concept page exists", () => {
    seedConceptPage("alice.md");
    memoryV2Bm25BReembedDisabledV2PagesMigration.run(workspaceDir);
    expect(countReembedJobs()).toBe(1);
  });

  test("enqueues when only a nested concept page exists", () => {
    seedConceptPage("people/alice.md");
    memoryV2Bm25BReembedDisabledV2PagesMigration.run(workspaceDir);
    expect(countReembedJobs()).toBe(1);
  });

  test("skips enqueue when memory.v2.enabled is explicitly false", () => {
    seedConceptPage("alice.md");
    writeConfig({ memory: { v2: { enabled: false } } });
    memoryV2Bm25BReembedDisabledV2PagesMigration.run(workspaceDir);
    expect(countReembedJobs()).toBe(0);
  });

  test("enqueues when config.json exists but memory.v2.enabled is not set", () => {
    seedConceptPage("alice.md");
    writeConfig({ memory: {} });
    memoryV2Bm25BReembedDisabledV2PagesMigration.run(workspaceDir);
    expect(countReembedJobs()).toBe(1);
  });

  test("enqueues when memory.v2.enabled is explicitly true", () => {
    seedConceptPage("alice.md");
    writeConfig({ memory: { v2: { enabled: true } } });
    memoryV2Bm25BReembedDisabledV2PagesMigration.run(workspaceDir);
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
    memoryV2Bm25BReembedDisabledV2PagesMigration.run(workspaceDir);
    expect(countReembedJobs()).toBe(1);
  });
});
