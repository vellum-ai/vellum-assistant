import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const TABLE = "acp_session_history";
const COLUMN = "auth_error_credential";

/**
 * Add a nullable `auth_error_credential TEXT` column to `acp_session_history`.
 *
 * Holds a digest of the Claude token the run was using when Claude refused it,
 * beside the `auth_error_code` that names the refusal. Together they let a
 * marker answer for itself whether it is still worth showing: a client asks
 * whether the credential named here is still the one a spawn would resolve,
 * rather than relying on a sweep having run at the right moment to clear it.
 *
 * A digest, never the token. It only ever has to be compared for equality, and
 * this outlives the run that produced it.
 *
 * `NULL` for rows written before this migration ran, and for every run that
 * ended for any other reason. A marker with no credential named is served
 * rather than hidden, since an unknown credential is no evidence the failure
 * was repaired.
 *
 * Idempotent: the PRAGMA guard makes re-running a no-op once the column
 * exists.
 */
export function migrateAcpSessionHistoryAuthErrorCredential(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  const columns = raw.query(`PRAGMA table_info(${TABLE})`).all() as Array<{
    name: string;
  }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has(COLUMN)) {
    raw.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TEXT`);
  }
}
