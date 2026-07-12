/**
 * One-time migration: drop the assistant's guardian-request tables now that
 * the gateway owns the request lifecycle, plus three production-dead legacy
 * tables from the pre-unification guardian models.
 *
 * Gated on m0015's `one_time_migrations` checkpoint: registration order alone
 * only guarantees m0015 ran *before* this migration, not that it succeeded
 * (the runner continues past a "skip"/throw). Once the checkpoint is present,
 * the m0015 copy pass reruns as a final catch-up — rows written to the
 * assistant tables between the backfill checkpoint and the daemon's flip to
 * the gateway client would otherwise be dropped with their source tables.
 * INSERT OR IGNORE keeps the rerun idempotent and gateway rows authoritative,
 * and a decision-carry pass then copies terminal statuses onto gateway rows
 * the earlier backfill left pending (never overwriting a gateway decision).
 *
 * Drops, in FK order (children before parents):
 * - `canonical_guardian_deliveries`, `canonical_guardian_requests` — moved to
 *   the gateway (`guardian_request_deliveries`, `guardian_requests`).
 * - `guardian_action_deliveries`, `guardian_action_requests` — legacy voice
 *   guardian model, unified into the canonical tables by assistant migration
 *   121; zero non-test consumers.
 * - `channel_guardian_approval_requests` — legacy channel approval model,
 *   likewise superseded by the unified tables; zero non-test consumers.
 *
 * "skip" when the catch-up copy or any IPC drop fails so the runner retries
 * next boot; the copy and DROP TABLE IF EXISTS are idempotent on that retry.
 */

import { Database } from "bun:sqlite";

import { getGatewayDb } from "../connection.js";
import { getLogger } from "../../logger.js";
import { assistantDbQuery, assistantDbRun } from "../assistant-db-proxy.js";
import { up as runGuardianRequestsCopyPass } from "./m0015-guardian-requests-backfill.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0016-drop-assistant-guardian-tables");

function getRawGatewayDb(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

/** `one_time_migrations` key the runner records when m0015 completes. */
export const M0015_CHECKPOINT_KEY = "m0015-guardian-requests-backfill";

/** Dropped in this order so no child table ever outlives its parent. */
const DROP_ORDER = [
  "canonical_guardian_deliveries",
  "canonical_guardian_requests",
  "guardian_action_deliveries",
  "guardian_action_requests",
  "channel_guardian_approval_requests",
] as const;

export async function up(): Promise<MigrationResult> {
  const gwDb = getRawGatewayDb();

  const backfillDone = gwDb
    .prepare(`SELECT 1 FROM one_time_migrations WHERE key = ?`)
    .get(M0015_CHECKPOINT_KEY);
  if (!backfillDone) {
    log.info(
      "m0016: m0015 checkpoint absent — skipping drops until the backfill completes",
    );
    return "skip";
  }

  // Final catch-up copy: rerun the m0015 pass (same mapping, INSERT OR
  // IGNORE) so rows that landed assistant-side after the backfill
  // checkpointed survive the drop. "done" also covers an already-absent
  // source table; "skip" retries next boot with nothing dropped.
  if ((await runGuardianRequestsCopyPass()) !== "done") {
    log.warn(
      "m0016: catch-up guardian-request copy did not complete — deferring drops to next startup",
    );
    return "skip";
  }

  // Decision catch-up: INSERT OR IGNORE cannot propagate a decision made
  // assistant-side AFTER the backfill copied the row as pending. Carry the
  // decision fields onto gateway rows that are still pending — a gateway-side
  // decision always wins over the assistant copy.
  try {
    const sourcePresent = await assistantDbQuery(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ["canonical_guardian_requests"],
    );
    if (sourcePresent.length > 0) {
      const decided = await assistantDbQuery<{
        id: string;
        status: string;
        answer_text: string | null;
        decided_by_external_user_id: string | null;
        decided_by_principal_id: string | null;
        followup_state: string | null;
        updated_at: number;
      }>(
        `SELECT id, status, answer_text, decided_by_external_user_id,
                decided_by_principal_id, followup_state, updated_at
           FROM canonical_guardian_requests
          WHERE status != 'pending'`,
      );

      if (decided.length > 0) {
        const carryDecision = gwDb.prepare(
          `UPDATE guardian_requests
              SET status = ?, answer_text = ?, decided_by_external_user_id = ?,
                  decided_by_principal_id = ?, followup_state = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'`,
        );
        let carried = 0;
        gwDb.transaction(() => {
          for (const row of decided) {
            carried += carryDecision.run(
              row.status,
              row.answer_text,
              row.decided_by_external_user_id,
              row.decided_by_principal_id,
              row.followup_state,
              row.updated_at,
              row.id,
            ).changes;
          }
        })();
        if (carried > 0) {
          log.info(
            { carried },
            "m0016: carried late assistant-side decisions onto pending gateway rows",
          );
        }
      }
    }
  } catch (err) {
    log.warn(
      { err },
      "m0016: decision catch-up failed — deferring drops to next startup",
    );
    return "skip";
  }

  try {
    for (const table of DROP_ORDER) {
      await assistantDbRun(`DROP TABLE IF EXISTS ${table}`);
    }
  } catch (err) {
    log.error(
      { err },
      "m0016: assistant guardian table drop failed — will retry on next startup",
    );
    return "skip";
  }

  log.info(
    "m0016: dropped assistant guardian-request tables and legacy guardian tables",
  );
  return "done";
}

export function down(): MigrationResult {
  // No-op: the dropped assistant tables are not restorable.
  return "done";
}
