/**
 * `contacts.role` and `contacts.principal_id` exist only on assistant DBs that
 * predate their drop (assistant persistence migration 305). Migrations that
 * copy the ACL source into the gateway probe with this helper first: once the
 * columns are gone they are never coming back, so there is nothing to reconcile
 * and nothing to wait for.
 */

import { assistantDbQuery } from "../assistant-db-proxy.js";

export async function assistantHasContactAclColumns(): Promise<boolean> {
  const rows = await assistantDbQuery(
    `SELECT name FROM pragma_table_info('contacts')
      WHERE name IN ('role', 'principal_id')`,
  );
  return rows.length === 2;
}
