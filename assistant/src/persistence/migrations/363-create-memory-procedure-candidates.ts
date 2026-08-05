import type { Database } from "bun:sqlite";

import { getLogger } from "../../util/logger.js";
import { getMemorySqlite } from "../db-connection.js";

const log = getLogger("memory-db");

/**
 * Create the procedure-candidate tables on the memory connection.
 *
 * Three tables, each carrying one structural invariant of the stabilization
 * layer (see
 * `plugins/defaults/memory/procedure-candidate-stabilizer.ts`):
 *
 *   - `memory_procedure_candidates` holds one row per procedure cluster. The
 *     PARTIAL UNIQUE INDEX on `normalized_goal WHERE status = 'pending'` is
 *     what stops two concurrent first observations of one procedure from
 *     forking sibling clusters; the same index makes the proposed skill id a
 *     second deterministic cluster key via its own partial unique index.
 *   - `memory_procedure_candidate_sources` holds one row per contributing
 *     source conversation. `PRIMARY KEY (candidate_id, source_conversation_id)`
 *     is what makes double-counting one conversation structurally
 *     impossible: a re-observation upserts the same row, which is also how a
 *     same-source correction supersedes its predecessor. Promotion counts
 *     rows here, so recurrence cannot be forged by reprocessing.
 *   - `memory_procedure_promotions` is the promotion claim, keyed by the
 *     canonical `skill_id`. Exactly one candidate can own the claim on a
 *     skill id, and `completed_at` distinguishes a crash before the skill
 *     write from one after it, so the owning candidate can resume either way
 *     while a different candidate is rejected.
 *
 * Idempotent (`IF NOT EXISTS`); exported so tests can stand up the
 * memory-side schema without running the migration chain.
 */
export function ensureMemoryProcedureCandidatesSchema(
  memoryRaw: Database,
): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_procedure_candidates (
      id TEXT PRIMARY KEY,
      normalized_goal TEXT NOT NULL,
      goal TEXT NOT NULL,
      proposed_skill_id TEXT NOT NULL,
      artifact TEXT NOT NULL,
      matched_skill_id TEXT,
      status TEXT NOT NULL,
      canonical_skill_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_procedure_candidates_pending_goal
      ON memory_procedure_candidates(normalized_goal)
      WHERE status = 'pending';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_procedure_candidates_pending_skill_id
      ON memory_procedure_candidates(proposed_skill_id)
      WHERE status = 'pending';

    CREATE INDEX IF NOT EXISTS idx_memory_procedure_candidates_matched
      ON memory_procedure_candidates(matched_skill_id);

    CREATE TABLE IF NOT EXISTS memory_procedure_candidate_sources (
      candidate_id TEXT NOT NULL,
      source_conversation_id TEXT NOT NULL,
      retrospective_conversation_id TEXT NOT NULL,
      evidence TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY (candidate_id, source_conversation_id)
    );

    CREATE TABLE IF NOT EXISTS memory_procedure_promotions (
      skill_id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      completed_at INTEGER
    );
  `);
}

/**
 * Migration step: ensure the procedure-candidate tables exist on the memory
 * database. They are born on the memory connection (no relocation from
 * main). An unavailable memory database logs and skips rather than failing
 * startup; the store re-runs {@link ensureMemoryProcedureCandidatesSchema} on
 * its first access per process, so a skip here only defers creation, and
 * retrospective captures fail closed until the connection is available.
 */
export async function migrateCreateMemoryProcedureCandidates(): Promise<void> {
  const memoryRaw = getMemorySqlite();
  if (!memoryRaw) {
    log.warn(
      "memory database unavailable; deferring memory_procedure_candidates creation to first store access",
    );
    return;
  }
  ensureMemoryProcedureCandidatesSchema(memoryRaw);
}
