import { loadRawConfig } from "../../config/loader.js";
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
 * Ownership guard: the companion workspace migration keeps a `balanced-economy`
 * profile the user owns (`source !== "managed"`) intact, so its pins still
 * resolve and must not be touched. Memory migrations run before workspace
 * migrations on boot, so the profile is still in config here either way; gate on
 * its source rather than its presence. A reserved managed key (or no profile at
 * all) means every pin is stale and safe to rewrite.
 *
 * Idempotent: the WHERE clause matches nothing once rewritten. The PRAGMA guard
 * skips a table an install hasn't created the column on yet.
 */
export function migrateRewriteBalancedEconomyProfilePins(
  database: DrizzleDb,
): void {
  if (isUserOwnedEconomyProfile()) return;

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

/** True when `balanced-economy` exists in config as a user-owned profile. */
function isUserOwnedEconomyProfile(): boolean {
  const llm = asObject(loadRawConfig().llm);
  const profile = asObject(asObject(llm?.profiles)?.[OLD_PROFILE]);
  return profile !== null && profile.source !== "managed";
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
