import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import type { WorkspaceMigration } from "./types.js";

/**
 * Enqueue a one-shot `memory_v2_reembed` job so existing concept pages pick
 * up the new `memory.v2.bm25_b` default (0.4, lowered from 0.75 in PR
 * #29345). `embed_concept_page` bakes `bm25_b` into the stored sparse
 * vectors at write time, so without this nudge workspaces that never pinned
 * the field would silently mix old and new length normalization until a
 * manual reembed.
 */
export const memoryV2Bm25BDefaultReembedMigration: WorkspaceMigration = {
  id: "075-memory-v2-bm25-b-default-reembed",
  description:
    "Enqueue memory_v2_reembed so existing concept pages pick up the new bm25_b=0.4 default",

  run(workspaceDir: string): void {
    const dbPath = join(workspaceDir, "data", "db", "assistant.db");
    if (!existsSync(dbPath)) return; // Fresh install — pages will embed at the new default.

    let db: Database;
    try {
      db = new Database(dbPath);
    } catch {
      return;
    }

    try {
      const tableRow = db
        .query(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_jobs'`,
        )
        .get();
      if (!tableRow) return;

      const existing = db
        .query(
          `SELECT id FROM memory_jobs WHERE type='memory_v2_reembed' AND status IN ('pending','running') LIMIT 1`,
        )
        .get();
      if (existing) return;

      const now = Date.now();
      db.query(
        `INSERT INTO memory_jobs
           (id, type, payload, status, attempts, deferrals, run_after, last_error, created_at, updated_at)
         VALUES (?, 'memory_v2_reembed', '{}', 'pending', 0, 0, ?, NULL, ?, ?)`,
      ).run(randomUUID(), now, now, now);
    } finally {
      db.close();
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: the reembed is a one-shot data refresh.
  },
};
