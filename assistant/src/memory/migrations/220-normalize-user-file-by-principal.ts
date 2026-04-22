import { computeUserFileBaseSlug } from "../../contacts/contact-store.js";
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
 * Heuristic: does `userFile` look like an auto-incremented persona slug?
 *
 * `generateUserFileSlug` appends `-<N>.md` where N is any positive integer
 * (the loop is unbounded, so a very dense principal space could reach 4+
 * digits). Matching is anchored to the end so a slug that happens to contain
 * digits earlier (e.g. `alex-2024.md` for display name "Alex 2024") is not
 * affected.
 *
 * The final-integer suffix also matches year-like or date-like names
 * (`-2025.md`, `-2025-04-13.md` via the trailing `-13.md`). Those must NOT
 * be classified as auto-increments, so we exclude any filename that ends
 * with a date-shaped tail: `-YYYY.md`, `-YYYY-MM.md`, or `-YYYY-MM-DD.md`
 * where YYYY is a 4-digit year starting with 19, 20, or 21. A counter that
 * happens to fall in that range (e.g. `-1999.md`) is indistinguishable from
 * a year by filename alone, so we conservatively treat it as non-auto.
 *
 * Month/day segments must be 2 digits (ISO style) to discriminate them from
 * single-digit collision counters: `generateUserFileSlug` emits `-2.md`,
 * `-3.md`, etc. without leading zeros, so `alex-2025-2.md` is a counter on
 * base `alex-2025.md` — not a date — and must remain classified as auto.
 *
 * Filename-only classification is still ambiguous at the margins: a display
 * name like "Alex 2025 4" legitimately produces `alex-2025-4.md` as a base
 * slug, which looks identical to a year-prefixed counter. When the caller can
 * supply the row's display name, we disambiguate by recomputing the expected
 * base slug: if it matches the filename, the name is a base slug and we
 * classify as non-auto. This closes the only remaining false-positive hole.
 */
const DATE_LIKE_SUFFIX = /-(19|20|21)\d{2}((-\d{2}){1,2})?\.md$/;
const INTEGER_SUFFIX = /-\d+\.md$/;

export function isAutoIncrementedUserFile(
  userFile: string,
  displayName?: string,
): boolean {
  if (DATE_LIKE_SUFFIX.test(userFile)) return false;
  if (!INTEGER_SUFFIX.test(userFile)) return false;
  if (displayName !== undefined) {
    const expectedBase = `${computeUserFileBaseSlug(displayName)}.md`;
    if (expectedBase === userFile) return false;
  }
  return true;
}

/**
 * Normalize `contacts.user_file` across contact rows that share the same
 * `principal_id`.
 *
 * Multiple contact rows may represent the same principal (one per channel:
 * desktop, phone, Slack, etc.). When a new row was created for a second
 * channel, `generateUserFileSlug(displayName)` auto-incremented to avoid a
 * filename collision (e.g. `alice.md` → `alice-2.md`), even though no
 * `alice-2.md` file ever existed on disk. The persona resolver then silently
 * fell back to `users/default.md` for that channel's messages — and the same
 * slug is used for the journal directory, so the user lost per-principal
 * continuity on every non-primary channel.
 *
 * This migration picks one canonical `user_file` per principal and updates
 * every sibling row to match. Selection heuristic:
 *
 *   1. Prefer values that do NOT look auto-incremented (see
 *      `isAutoIncrementedUserFile`).
 *   2. Among those, prefer the oldest contact row (earliest `created_at`).
 *   3. Ties broken by `id` for determinism.
 *
 * Skips principals where only one distinct (non-null) value exists — nothing
 * to normalize. Principals whose contacts all have `user_file = NULL` are
 * left untouched; the code path in `upsertContact` will populate them on the
 * next write.
 */
export function migrateNormalizeUserFileByPrincipal(database: DrizzleDb): void {
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

        // Fetch all non-null candidates and rank in JS. The auto-increment
        // classification is a regex that SQLite's GLOB can't express cleanly
        // (unbounded digit count, date-pattern exclusion), and keeping the
        // logic in one place avoids SQL/JS drift.
        const selectCandidates = raw.prepare(/*sql*/ `
          SELECT user_file, display_name, created_at, id FROM contacts
          WHERE principal_id = ? AND user_file IS NOT NULL
          `);

        const updateSiblings = raw.prepare(/*sql*/ `
          UPDATE contacts
          SET user_file = ?, updated_at = ?
          WHERE principal_id = ?
            AND (user_file IS NULL OR user_file != ?)
          `);

        for (const { principal_id } of principals) {
          const candidates = selectCandidates.all(principal_id) as Array<{
            user_file: string;
            display_name: string;
            created_at: number;
            id: string;
          }>;
          if (candidates.length === 0) continue;

          candidates.sort((a, b) => {
            const aAuto = isAutoIncrementedUserFile(a.user_file, a.display_name)
              ? 1
              : 0;
            const bAuto = isAutoIncrementedUserFile(b.user_file, b.display_name)
              ? 1
              : 0;
            if (aAuto !== bAuto) return aAuto - bAuto;
            if (a.created_at !== b.created_at)
              return a.created_at - b.created_at;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          });

          const canonical = candidates[0]!.user_file;
          updateSiblings.run(canonical, Date.now(), principal_id, canonical);
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
