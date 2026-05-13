import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
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
 *
 * Gated on whether the workspace already has concept pages on disk, not on
 * `memory.v2.enabled`. A workspace that has v2 disabled today may still
 * carry pages from a prior session; if v2 is re-enabled later, the queued
 * job is what brings those pages onto the new default. Workspaces that
 * have never written a v2 page have nothing to reembed.
 */
export const memoryV2Bm25BDefaultReembedMigration: WorkspaceMigration = {
  id: "075-memory-v2-bm25-b-default-reembed",
  description:
    "Enqueue memory_v2_reembed so existing concept pages pick up the new bm25_b=0.4 default",

  run(workspaceDir: string): void {
    if (!hasConceptPages(workspaceDir)) return;

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

/**
 * Returns true when `memory/concepts/` contains any `.md` file. Walks the
 * tree iteratively so we bail on the first hit — pages can be nested in
 * subdirectories (e.g. `memory/concepts/people/alice.md`).
 */
function hasConceptPages(workspaceDir: string): boolean {
  const stack = [join(workspaceDir, "memory", "concepts")];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        return true;
      }
    }
  }
  return false;
}
