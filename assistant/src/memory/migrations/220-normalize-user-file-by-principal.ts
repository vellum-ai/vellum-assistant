import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Reverse is a no-op. This migration only consolidates `user_file` across
 * contacts sharing the same `principal_id`; the pre-migration split values
 * cannot be reconstructed after normalization, and no schema changes.
 */
export function downNormalizeUserFileByPrincipal(_database: DrizzleDb): void {
  /* no-op */
}

/**
 * Normalize `contacts.user_file` across contact rows that share the same
 * `principal_id`.
 *
 * Multiple contact rows may represent the same principal (one per channel:
 * desktop, phone, Slack, etc.). When a new row was created for a second
 * channel, `generateUserFileSlug(displayName)` auto-incremented to avoid a
 * filename collision (e.g. `sidd.md` → `sidd-2.md`), even though no
 * `sidd-2.md` file ever existed on disk. The persona resolver then silently
 * fell back to `users/default.md` for that channel's messages — and the same
 * slug is used for the journal directory, so the user lost per-principal
 * continuity on every non-primary channel.
 *
 * This migration picks one canonical `user_file` per principal and updates
 * every sibling row to match. Selection heuristic:
 *
 *   1. Prefer values that do NOT look auto-incremented. Auto-increment tails
 *      are `-<N>.md` where N is 1–3 digits (matches `generateUserFileSlug`'s
 *      counter). Matching is anchored to the end of the filename so a slug
 *      that happens to contain a numeric segment (e.g. `alex-2024.md` — a
 *      display name with a year) is NOT classified as auto-incremented.
 *   2. Among those, prefer the oldest contact row (earliest `created_at`).
 *   3. Ties broken by `id` for determinism.
 *
 * Skips principals where only one distinct (non-null) value exists — nothing
 * to normalize. Principals whose contacts all have `user_file = NULL` are
 * left untouched; the code path in `upsertContact` will populate them on the
 * next write.
 */
export function migrateNormalizeUserFileByPrincipal(
  database: DrizzleDb,
): void {
  withCrashRecovery(
    database,
    "migration_normalize_user_file_by_principal_v1",
    () => {
      const raw = getSqliteFrom(database);

      const tableExists = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'contacts'`,
        )
        .get();
      if (!tableExists) return;

      const userFileColExists = raw
        .query(
          `SELECT 1 FROM pragma_table_info('contacts') WHERE name = 'user_file'`,
        )
        .get();
      const principalColExists = raw
        .query(
          `SELECT 1 FROM pragma_table_info('contacts') WHERE name = 'principal_id'`,
        )
        .get();
      if (!userFileColExists || !principalColExists) return;

      try {
        raw.exec("BEGIN");

        const principals = raw
          .query(
            /*sql*/ `
            SELECT principal_id
            FROM contacts
            WHERE principal_id IS NOT NULL
            GROUP BY principal_id
            HAVING COUNT(DISTINCT COALESCE(user_file, '')) > 1
          `,
          )
          .all() as Array<{ principal_id: string }>;

        const selectCanonical = raw.prepare(
          /*sql*/ `
          SELECT user_file FROM contacts
          WHERE principal_id = ? AND user_file IS NOT NULL
          ORDER BY
            CASE
              WHEN user_file GLOB '*-[0-9].md'
                OR user_file GLOB '*-[0-9][0-9].md'
                OR user_file GLOB '*-[0-9][0-9][0-9].md'
              THEN 1 ELSE 0
            END,
            created_at ASC,
            id ASC
          LIMIT 1
          `,
        );

        const updateSiblings = raw.prepare(
          /*sql*/ `
          UPDATE contacts
          SET user_file = ?, updated_at = ?
          WHERE principal_id = ?
            AND (user_file IS NULL OR user_file != ?)
          `,
        );

        for (const { principal_id } of principals) {
          const canonical = selectCanonical.get(principal_id) as {
            user_file: string;
          } | null;
          if (!canonical?.user_file) continue;
          updateSiblings.run(
            canonical.user_file,
            Date.now(),
            principal_id,
            canonical.user_file,
          );
        }

        raw.exec("COMMIT");
      } catch (e) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* no active transaction */
        }
        throw e;
      }
    },
  );
}
