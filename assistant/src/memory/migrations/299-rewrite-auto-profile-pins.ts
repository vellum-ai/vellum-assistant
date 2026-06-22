import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const OLD_PROFILE = "auto";
const NEW_PROFILE = "balanced";
const PIN_TABLES = ["conversations", "cron_jobs"] as const;

export function migrateRewriteAutoProfilePins(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  for (const table of PIN_TABLES) {
    const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    if (!cols.some((c) => c.name === "inference_profile")) continue;

    raw
      .prepare(
        `UPDATE ${table} SET inference_profile = ? WHERE inference_profile = ?`,
      )
      .run(NEW_PROFILE, OLD_PROFILE);
  }
}
