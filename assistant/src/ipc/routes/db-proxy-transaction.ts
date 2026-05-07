/**
 * ⚠️  TEMPORARY HACK — DO NOT EXTEND ⚠️
 *
 * IPC route that lets the gateway execute multiple write statements against
 * the assistant's SQLite database inside a single atomic transaction.
 *
 * Companion to db-proxy.ts. Exists because some gateway-orchestrated writes
 * (e.g. invite redemption: upsert contact channel + record invite use) must
 * be all-or-nothing. With the contacts/guardian/invite tables still living
 * in the assistant DB, the gateway needs a way to commit several writes
 * atomically there.
 *
 * Each step is a write (INSERT/UPDATE/DELETE). All steps run inside a
 * BEGIN IMMEDIATE transaction. If any step throws — including a step whose
 * `requireChanges` constraint is unmet — the entire transaction rolls back.
 *
 * Read-modify-write across steps is not supported (the IPC is one-shot;
 * later steps cannot react to earlier step results except via SQL conditions
 * embedded in the WHERE clause and the optional `requireChanges` guard).
 *
 * This route is intentionally NOT in the shared ROUTES array — it is a
 * private implementation detail between the gateway and assistant IPC
 * servers and must not be discoverable by clients or the OpenAPI spec.
 *
 * Remove once contacts/guardian/invite logic is fully migrated to the
 * gateway's own database.
 */

import { getSqlite } from "../../memory/db-connection.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("db-proxy-transaction");

/** Column value types that SQLite can return. */
type SqliteValue = string | number | null | Uint8Array;

export interface DbProxyTransactionStep {
  /** The SQL write statement to execute. */
  sql: string;
  /** Positional bind parameters. */
  bind?: SqliteValue[];
  /**
   * If set, abort the transaction (rollback) when this step's row-change
   * count is below this threshold. Used for stale-write detection — e.g.
   * "increment use_count only if status = 'active' AND use_count < max_uses",
   * with `requireChanges: 1` to abort when no rows match.
   */
  requireChanges?: number;
}

export interface DbProxyTransactionParams {
  steps: DbProxyTransactionStep[];
}

export type DbProxyTransactionResult =
  | {
      ok: true;
      results: Array<{ changes: number; lastInsertRowid: number }>;
    }
  | {
      ok: false;
      reason: "require_changes_failed";
      failedStep: number;
      actualChanges: number;
      requiredChanges: number;
    };

export function handleDbProxyTransaction(
  params: DbProxyTransactionParams,
): DbProxyTransactionResult {
  const db = getSqlite();

  if (!Array.isArray(params.steps) || params.steps.length === 0) {
    throw new Error("db_proxy_transaction requires at least one step");
  }

  // Sentinel used to abort the transaction without leaking through as a generic
  // SQL error. Better-sqlite3 rolls back when the inner function throws.
  class RequireChangesFailure extends Error {
    constructor(
      public failedStep: number,
      public actualChanges: number,
      public requiredChanges: number,
    ) {
      super(
        `Step ${failedStep} affected ${actualChanges} rows, requires ${requiredChanges}`,
      );
    }
  }

  const results: Array<{ changes: number; lastInsertRowid: number }> = [];

  try {
    db.transaction(() => {
      for (let i = 0; i < params.steps.length; i++) {
        const step = params.steps[i];
        const stmt = db.prepare(step.sql);
        const result = step.bind ? stmt.run(...step.bind) : stmt.run();
        const changes = result.changes;
        results.push({
          changes,
          lastInsertRowid: Number(result.lastInsertRowid),
        });

        if (
          step.requireChanges !== undefined &&
          changes < step.requireChanges
        ) {
          throw new RequireChangesFailure(i, changes, step.requireChanges);
        }
      }
    }).immediate();
  } catch (err) {
    if (err instanceof RequireChangesFailure) {
      log.debug(
        {
          failedStep: err.failedStep,
          actualChanges: err.actualChanges,
          requiredChanges: err.requiredChanges,
        },
        "db-proxy-transaction aborted by requireChanges guard",
      );
      return {
        ok: false,
        reason: "require_changes_failed",
        failedStep: err.failedStep,
        actualChanges: err.actualChanges,
        requiredChanges: err.requiredChanges,
      };
    }
    throw err;
  }

  log.debug(
    { stepCount: params.steps.length },
    "db-proxy-transaction committed",
  );
  return { ok: true, results };
}
