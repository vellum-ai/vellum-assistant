import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const OLD_PROFILE = "balanced-economy";
const NEW_PROFILE = "balanced";

// Active inference-profile pin columns: the per-conversation override and the
// per-schedule override. Audit/telemetry tables (tool_invocations,
// llm_usage_events, skill_loaded_events) also carry an `inference_profile`, but
// those record what actually ran and must keep their historical value.
const PIN_TABLES = ["conversations", "cron_jobs"] as const;

/**
 * Rewrite persisted `balanced-economy` inference-profile pins to `balanced`.
 *
 * The managed `balanced-economy` profile folds into `balanced` (both resolve to
 * MiniMax M3 on Fireworks). The workspace-config migration removes the profile
 * definition, but a profile key can also be pinned outside config.json — on a
 * conversation (`conversations.inference_profile`) or a schedule
 * (`cron_jobs.inference_profile`). Left unrewritten those pins dangle, and
 * `resolveCallSiteConfig` treats an unresolvable override as a silent
 * fall-through to the active/default profile — dropping the user's intended
 * MiniMax route. `balanced-economy` is a reserved managed-profile key, so every
 * persisted pin refers to the now-folded profile.
 *
 * Idempotent: the WHERE clause matches nothing once rewritten. The PRAGMA guard
 * skips a table an install hasn't created the column on yet.
 */
export function migrateRewriteBalancedEconomyProfilePins(
  database: DrizzleDb,
): void {
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
