/**
 * Workspace migration `082-backfill-managed-profile-labels`.
 *
 * Backfills `label` on the three canonical managed inference profiles
 * (`balanced`, `quality-optimized`, `cost-optimized`) when the on-disk
 * profile is missing it.
 *
 * Why this is needed
 * ------------------
 * Migration 052 (`seed-default-inference-profiles`) seeds the three
 * canonical Anthropic profiles with provider/model/maxTokens/effort/
 * thinking but **no `label`** field. The runtime profile seeder
 * (`seedInferenceProfiles`) materializes labels on its second pass —
 * but only when the profile didn't already exist. In platform mode
 * (`IS_PLATFORM=true`) it deliberately defers to the existing on-disk
 * entry to avoid clobbering platform-supplied overlay fragments, so the
 * label never gets written.
 *
 * Net result: a fresh Cloud-hosted assistant (Marina QA #5, 0.8.1) shows
 * raw slugs in the profile picker — `balanced`, `quality-optimized`,
 * `cost-optimized` — instead of the human labels `Balanced`, `Quality`,
 * `Speed`. This migration heals existing installs by writing the bare
 * template label when absent.
 *
 * Behavior
 * --------
 *   - Missing config.json -> no-op.
 *   - Malformed JSON -> log and no-op.
 *   - `llm.profiles` absent -> no-op.
 *   - For each canonical name: backfill `label` only when the key is
 *     absent on disk. An explicit `null` (user cleared the label) is
 *     preserved. A user-set string is preserved.
 *   - Non-canonical profile names are never touched.
 *
 * Idempotent: running twice produces no second write.
 *
 * Does NOT skip on `VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH`: the platform
 * overlay supplies its own label when it cares, and the runtime seeder's
 * `preservedProfileNames` skip path will defer to that overlay-supplied
 * label on every boot. This migration only fills the gap when no source
 * (overlay, migration 052, or seeder) ever wrote a label.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger(
  "workspace-migration-082-backfill-managed-profile-labels",
);

/**
 * Bare template labels for the canonical managed profile triplet. Kept in
 * sync with `MANAGED_PROFILE_TEMPLATES` in
 * `assistant/src/config/seed-inference-profiles.ts`. Duplicated here
 * intentionally — migrations are forward-only and self-contained per the
 * workspace migrations AGENTS contract; future renames in the seeder
 * must NOT retroactively change the data this migration writes.
 */
const CANONICAL_MANAGED_PROFILE_LABELS: Record<string, string> = {
  balanced: "Balanced",
  "quality-optimized": "Quality",
  "cost-optimized": "Speed",
};

export const backfillManagedProfileLabelsMigration: WorkspaceMigration = {
  id: "082-backfill-managed-profile-labels",
  description:
    "Backfill label on canonical managed inference profiles when absent",

  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    let raw: string;
    try {
      raw = readFileSync(configPath, "utf-8");
    } catch (err) {
      log.warn(
        { err, path: configPath },
        "Failed to read config.json; skipping migration",
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.warn(
        { err, path: configPath },
        "Failed to parse config.json; skipping migration",
      );
      return;
    }

    if (!isPlainObject(parsed)) {
      return;
    }

    const llm = readObject(parsed.llm);
    if (!llm) return;

    const profiles = readObject(llm.profiles);
    if (!profiles) return;

    let modified = false;

    for (const [name, label] of Object.entries(
      CANONICAL_MANAGED_PROFILE_LABELS,
    )) {
      const profile = readObject(profiles[name]);
      if (!profile) continue;
      // Only backfill when the key is absent. Explicit `null` (user cleared
      // the label) and any user-set string both signal intent and survive.
      if ("label" in profile) continue;
      profile.label = label;
      modified = true;
    }

    if (!modified) return;

    try {
      writeFileSync(
        configPath,
        JSON.stringify(parsed, null, 2) + "\n",
        "utf-8",
      );
      log.info(
        { path: configPath },
        "Backfilled missing labels on canonical managed inference profiles",
      );
    } catch (err) {
      log.warn(
        { err, path: configPath },
        "Failed to write backfilled config.json; leaving prior file in place",
      );
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only data repair. Rolling back would re-break the picker
    // for installs whose only label source was this migration.
  },
};

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
