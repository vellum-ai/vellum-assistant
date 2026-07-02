/**
 * `contact_channels.invite_id` exists only on assistant DBs that predate its
 * drop (assistant persistence migration 314). Migrations that read the column
 * over the db proxy build their SELECT with this fragment so the row shape is
 * preserved — `NULL AS invite_id` — when the column is absent.
 */

import { assistantDbQuery } from "../assistant-db-proxy.js";

export async function assistantInviteIdSelect(): Promise<string> {
  const rows = await assistantDbQuery(
    `SELECT 1 FROM pragma_table_info('contact_channels') WHERE name = 'invite_id'`,
  );
  return rows.length > 0 ? "invite_id" : "NULL AS invite_id";
}
