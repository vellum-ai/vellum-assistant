import { type DrizzleDb, getSqliteFrom } from '../db-connection.js';
import { withCrashRecovery } from './validate-migration-state.js';

/**
 * Backfill guardianPrincipalId for existing channel_guardian_bindings and
 * canonical_guardian_requests rows.
 *
 * Strategy:
 *
 * 1. Derive the assistant's canonical principal from the active 'vellum'
 *    binding's guardianExternalUserId. This is the stable identity used for
 *    all guardian decisions from the desktop client.
 *
 * 2. Backfill channel_guardian_bindings: for every active binding that has
 *    a guardianExternalUserId but is missing guardianPrincipalId, set
 *    guardianPrincipalId = guardianExternalUserId. Each channel's external
 *    user ID *is* the principal identity for that channel.
 *
 * 3. Backfill canonical_guardian_requests (pending only):
 *    a. If the request has a guardianExternalUserId that maps to an active
 *       binding, use that binding's guardianPrincipalId (now backfilled).
 *    b. For desktop-originated requests (sourceType = 'desktop' or
 *       sourceChannel = 'vellum') that lack guardianExternalUserId,
 *       use the assistant principal derived in step 1.
 *    c. Pending requests that cannot be deterministically bound are expired.
 *
 * 4. Idempotent: uses checkpoint key + only updates rows with NULL
 *    guardianPrincipalId.
 */
export function migrateBackfillGuardianPrincipalId(database: DrizzleDb): void {
  withCrashRecovery(database, 'migration_backfill_guardian_principal_id_v1', () => {
    const raw = getSqliteFrom(database);

    // Guard: tables must exist
    const bindingsTableExists = raw.query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_guardian_bindings'`,
    ).get();
    if (!bindingsTableExists) return;

    const requestsTableExists = raw.query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'canonical_guardian_requests'`,
    ).get();

    // Guard: guardian_principal_id column must exist on bindings table
    const bindingColExists = raw.query(
      `SELECT 1 FROM pragma_table_info('channel_guardian_bindings') WHERE name = 'guardian_principal_id'`,
    ).get();
    if (!bindingColExists) return;

    try {
      raw.exec('BEGIN');

      // ── Step 1: Backfill channel_guardian_bindings ──────────────────
      // For every active binding missing guardianPrincipalId, set it to
      // the binding's own guardianExternalUserId. Each channel binding's
      // external user ID serves as that binding's principal identity.
      raw.exec(/*sql*/ `
        UPDATE channel_guardian_bindings
        SET guardian_principal_id = guardian_external_user_id,
            updated_at = ${Date.now()}
        WHERE status = 'active'
          AND guardian_external_user_id IS NOT NULL
          AND guardian_principal_id IS NULL
      `);

      // ── Step 2: Derive assistant principal from vellum binding ─────
      // The vellum binding's guardianExternalUserId is the canonical
      // assistant principal used for desktop-originated requests.
      const vellumBinding = raw.query(
        `SELECT guardian_external_user_id, guardian_principal_id FROM channel_guardian_bindings WHERE assistant_id = 'self' AND channel = 'vellum' AND status = 'active' LIMIT 1`,
      ).get() as { guardian_external_user_id: string; guardian_principal_id: string | null } | null;

      // Use the (now-backfilled) principal from the vellum binding
      const assistantPrincipal = vellumBinding?.guardian_principal_id ?? vellumBinding?.guardian_external_user_id ?? null;

      // ── Step 3: Backfill canonical_guardian_requests ────────────────
      if (requestsTableExists) {
        const requestColExists = raw.query(
          `SELECT 1 FROM pragma_table_info('canonical_guardian_requests') WHERE name = 'guardian_principal_id'`,
        ).get();

        if (requestColExists) {
          const now = new Date().toISOString();

          // 3a. Pending requests with a guardianExternalUserId that maps
          // to an active binding — use the binding's principal.
          const pendingWithGuardian = raw.query(
            `SELECT r.id, r.guardian_external_user_id
             FROM canonical_guardian_requests r
             WHERE r.status = 'pending'
               AND r.guardian_principal_id IS NULL
               AND r.guardian_external_user_id IS NOT NULL`,
          ).all() as Array<{ id: string; guardian_external_user_id: string }>;

          // Build a lookup of guardianExternalUserId -> principalId from
          // active bindings (all already backfilled in step 1).
          const activeBindings = raw.query(
            `SELECT guardian_external_user_id, guardian_principal_id
             FROM channel_guardian_bindings
             WHERE assistant_id = 'self' AND status = 'active' AND guardian_principal_id IS NOT NULL`,
          ).all() as Array<{ guardian_external_user_id: string; guardian_principal_id: string }>;

          const externalToP = new Map<string, string>();
          for (const b of activeBindings) {
            externalToP.set(b.guardian_external_user_id, b.guardian_principal_id);
          }

          const updateStmt = raw.prepare(
            `UPDATE canonical_guardian_requests SET guardian_principal_id = ?, updated_at = ? WHERE id = ?`,
          );
          const expireStmt = raw.prepare(
            `UPDATE canonical_guardian_requests SET status = 'expired', updated_at = ? WHERE id = ?`,
          );

          const unboundRequestIds: string[] = [];

          for (const req of pendingWithGuardian) {
            const principal = externalToP.get(req.guardian_external_user_id);
            if (principal) {
              updateStmt.run(principal, now, req.id);
            } else {
              // Cannot deterministically map — will expire below
              unboundRequestIds.push(req.id);
            }
          }

          // 3b. Desktop-originated pending requests missing guardian info
          // entirely — bind to the assistant principal. Only applies to
          // requests that also lack a guardian external user ID; requests
          // that carry an external ID but failed step 3a mapping should be
          // expired, not reassigned.
          if (assistantPrincipal) {
            raw.query(
              `UPDATE canonical_guardian_requests
               SET guardian_principal_id = ?, updated_at = ?
               WHERE status = 'pending'
                 AND guardian_principal_id IS NULL
                 AND guardian_external_user_id IS NULL
                 AND (source_type = 'desktop' OR source_channel = 'vellum')`,
            ).run(assistantPrincipal, now);
          }

          // 3c. Expire remaining pending requests that still have no
          // guardian_principal_id AND whose TTL has already elapsed.
          // Requests without an expires_at or whose TTL has not yet passed
          // are left alone so in-flight operations (e.g. voice
          // pending_question records) are not prematurely killed by the
          // migration.
          const stillUnbound = raw.query(
            `SELECT id FROM canonical_guardian_requests
             WHERE status = 'pending'
               AND guardian_principal_id IS NULL
               AND expires_at IS NOT NULL
               AND expires_at < ?`,
          ).all(now) as Array<{ id: string }>;

          for (const req of stillUnbound) {
            expireStmt.run(now, req.id);
          }

          // Also expire requests identified in 3a that had no binding match,
          // but only if their TTL has already elapsed (same rationale as 3c).
          for (const id of unboundRequestIds) {
            const check = raw.query(
              `SELECT guardian_principal_id, expires_at FROM canonical_guardian_requests WHERE id = ? AND status = 'pending'`,
            ).get(id) as { guardian_principal_id: string | null; expires_at: string | null } | null;
            if (check && !check.guardian_principal_id && check.expires_at && check.expires_at < now) {
              expireStmt.run(now, id);
            }
          }
        }
      }

      raw.exec('COMMIT');
    } catch (e) {
      try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw e;
    }
  });
}
