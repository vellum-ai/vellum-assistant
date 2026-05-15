import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import type { WorkspaceMigration } from "./types.js";

/**
 * Follow-up to `075-memory-v2-bm25-b-default-reembed`. Migration 075 shipped
 * in v0.8.1 with no gating beyond "db exists", so workspaces with no v2
 * pages still recorded a checkpoint entry and a queued reembed job. We
 * cannot edit 075 to add gating retroactively — the runner skips any
 * already-checkpointed id — so this migration re-runs the enqueue with the
 * gating we want now.
 *
 * Two gates:
 *
 * 1. `hasConceptPages` — only enqueue if `memory/concepts/` actually has a
 *    `.md` page. Workspaces that never wrote a v2 page have nothing to
 *    reembed.
 * 2. `isMemoryV2Disabled` — skip when `memory.v2.enabled` is explicitly
 *    `false`. The worker does not currently gate `memory_v2_reembed`
 *    dispatch on the config flag, so enqueueing for a workspace that
 *    intentionally disabled v2 would immediately re-embed pages and hit
 *    the embedding backend against the user's intent.
 */
export const memoryV2Bm25BReembedDisabledV2PagesMigration: WorkspaceMigration =
  {
    id: "085-memory-v2-bm25-b-reembed-disabled-v2-pages",
    description:
      "Re-enqueue memory_v2_reembed for workspaces with v2 pages, gated on v2 not being explicitly disabled",

    run(workspaceDir: string): void {
      if (isMemoryV2Disabled(workspaceDir)) return;
      if (!hasConceptPages(workspaceDir)) return;

      const dbPath = join(workspaceDir, "data", "db", "assistant.db");
      if (!existsSync(dbPath)) return;

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
 * Returns true only when `memory.v2.enabled` is explicitly set to `false`
 * in the workspace `config.json`. Missing/unparseable config falls through
 * to the schema default (enabled), matching `MemoryV2ConfigSchema`.
 */
function isMemoryV2Disabled(workspaceDir: string): boolean {
  const configPath = join(workspaceDir, "config.json");
  if (!existsSync(configPath)) return false;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const memory = (raw as { memory?: { v2?: { enabled?: unknown } } })?.memory;
    return memory?.v2?.enabled === false;
  } catch {
    return false;
  }
}

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
