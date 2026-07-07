/**
 * IPC route that lets gateway one-time data migrations execute raw SQL
 * against the assistant's SQLite database. Migrations (m0002, m0010, m0014,
 * et al.) need raw read/drop access to legacy assistant tables on first boot
 * of upgraded installs, and cross-container SQLite file access corrupts the
 * DB on platform pods (fcntl locks are not shared across mount namespaces) —
 * so they go through this route.
 *
 * This route is intentionally NOT in the shared ROUTES array — it is a
 * private implementation detail between the gateway and assistant IPC
 * servers and must not be discoverable by clients or the OpenAPI spec.
 *
 * No runtime feature may use this surface: gateway callers are pinned to the
 * proxy module (`db/assistant-db-proxy.ts`) plus `db/data-migrations/` by
 * the allowlist guard (gateway `__tests__/db-proxy-allowlist.test.ts`).
 */

import { getSqlite } from "../../persistence/db-connection.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("db-proxy");

/** Column value types that SQLite can return. */
type SqliteValue = string | number | null | Uint8Array;

export interface DbProxyParams {
  /** The SQL statement to execute. */
  sql: string;
  /** Positional bind parameters. */
  bind?: SqliteValue[];
  /**
   * Execution mode:
   * - "query" — returns rows (SELECT)
   * - "run"   — returns { changes, lastInsertRowid } (INSERT/UPDATE/DELETE)
   * - "exec"  — returns nothing (DDL, PRAGMA, multi-statement)
   */
  mode: "query" | "run" | "exec";
}

export interface DbProxyResult {
  rows?: Record<string, SqliteValue>[];
  changes?: number;
  lastInsertRowid?: number;
}

export function handleDbProxy(params: DbProxyParams): DbProxyResult {
  const db = getSqlite();

  switch (params.mode) {
    case "query": {
      const stmt = db.prepare(params.sql);
      const rows = (
        params.bind ? stmt.all(...params.bind) : stmt.all()
      ) as Record<string, SqliteValue>[];
      log.debug({ sql: params.sql, rowCount: rows.length }, "db-proxy query");
      return { rows };
    }
    case "run": {
      const stmt = db.prepare(params.sql);
      const result = params.bind ? stmt.run(...params.bind) : stmt.run();
      log.debug({ sql: params.sql, changes: result.changes }, "db-proxy run");
      return {
        changes: result.changes,
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    }
    case "exec": {
      db.exec(params.sql);
      log.debug({ sql: params.sql }, "db-proxy exec");
      return {};
    }
  }
}
