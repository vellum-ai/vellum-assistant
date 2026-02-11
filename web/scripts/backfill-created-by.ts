/**
 * Backfill script: canonicalize assistants.created_by to user IDs.
 *
 * Legacy assistants may have created_by set to a username or display name
 * instead of the canonical user.id. This script resolves those values and
 * updates them in place.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/backfill-created-by.ts [--dry-run]
 */

import postgres from "postgres";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const sql = postgres(connectionString);

  try {
    // Find assistants whose created_by is not already a user.id
    const nonCanonical = await sql`
      SELECT a.id, a.created_by
      FROM assistants a
      WHERE a.created_by IS NOT NULL
        AND a.created_by != ''
        AND NOT EXISTS (
          SELECT 1 FROM "user" u WHERE u.id = a.created_by
        )
    `;

    if (nonCanonical.length === 0) {
      console.log("All assistants already have canonical created_by values.");
      return;
    }

    console.log(`Found ${nonCanonical.length} assistant(s) with non-canonical created_by values.\n`);

    let updated = 0;
    let skipped = 0;

    for (const row of nonCanonical) {
      const createdBy = (row.created_by as string).trim();

      // Try matching by username
      const byUsername = await sql`
        SELECT id FROM "user" WHERE username = ${createdBy} LIMIT 1
      `;
      if (byUsername.length === 1) {
        const userId = byUsername[0].id as string;
        if (dryRun) {
          console.log(`[DRY RUN] assistant ${row.id}: "${createdBy}" -> "${userId}" (matched by username)`);
        } else {
          await sql`UPDATE assistants SET created_by = ${userId} WHERE id = ${row.id}`;
          console.log(`Updated assistant ${row.id}: "${createdBy}" -> "${userId}" (matched by username)`);
        }
        updated++;
        continue;
      }

      // Try matching by display name (only if unique)
      const byName = await sql`
        SELECT id FROM "user" WHERE name = ${createdBy} LIMIT 2
      `;
      if (byName.length === 1) {
        const userId = byName[0].id as string;
        if (dryRun) {
          console.log(`[DRY RUN] assistant ${row.id}: "${createdBy}" -> "${userId}" (matched by name)`);
        } else {
          await sql`UPDATE assistants SET created_by = ${userId} WHERE id = ${row.id}`;
          console.log(`Updated assistant ${row.id}: "${createdBy}" -> "${userId}" (matched by name)`);
        }
        updated++;
        continue;
      }

      console.warn(`Skipped assistant ${row.id}: "${createdBy}" could not be resolved to a user`);
      skipped++;
    }

    console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}${dryRun ? " (dry run)" : ""}`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
