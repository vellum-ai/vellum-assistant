import type { DrizzleDb } from "../db-connection.js";

/**
 * Create the scoped_approval_grants table for channel-agnostic scoped
 * approval grants.  Supports two scope modes:
 *   - request_id: grant is scoped to a specific request
 *   - tool_signature: grant is scoped to a tool name + input digest
 *
 * Grants are one-time-use (active -> consumed via CAS) and carry a
 * mandatory TTL (expires_at).
 */
export function createScopedApprovalGrantsTable(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS scoped_approval_grants (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      scope_mode TEXT NOT NULL,
      request_id TEXT,
      tool_name TEXT,
      input_digest TEXT,
      request_channel TEXT NOT NULL,
      decision_channel TEXT NOT NULL,
      execution_channel TEXT,
      conversation_id TEXT,
      call_session_id TEXT,
      requester_external_user_id TEXT,
      guardian_external_user_id TEXT,
      status TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      consumed_by_request_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Index for request_id-based lookups (scope_mode = 'request_id')
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_scoped_grants_request_id ON scoped_approval_grants(request_id) WHERE request_id IS NOT NULL`,
  );

  // Index for tool_signature-based lookups (scope_mode = 'tool_signature')
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_scoped_grants_tool_sig ON scoped_approval_grants(tool_name, input_digest) WHERE tool_name IS NOT NULL`,
  );

  // Index for expiry sweeps
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_scoped_grants_status_expires ON scoped_approval_grants(status, expires_at)`,
  );
}
