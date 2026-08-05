import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Clear the machinery-written `"Speed"` label off the `cost-optimized`
 * profile so the code catalog's new label ("Cost") reaches existing installs.
 *
 * `label` is workspace-owned overlay state: a managed-source entry's label
 * wins over the code default (`WORKSPACE_OWNED_DEFAULT_FIELDS` in
 * `config/default-profile-catalog.ts`). Migration 082 and the pre-catalog
 * seeder both wrote `"Speed"` onto `cost-optimized`, and migration 126
 * carried it onto the thin stub, so without this the picker would show two
 * profiles named "Speed": `cost-optimized`'s stale overlay and
 * `latency-optimized`, the user-facing Speed profile.
 *
 * Deleting the key (rather than writing "Cost") returns the label to code
 * ownership, so later renames ship with a release instead of a migration.
 *
 * Only the exact string `"Speed"` is cleared. A user rename to anything else
 * survives, as does an explicit `null` (label deliberately cleared). A rename
 * that happened to be "Speed" is indistinguishable from the seeded value and
 * is cleared too.
 *
 * Deliberately does NOT touch the `"Speed (Managed)"` label on BYOK hatch
 * stubs: `ensureByokDefaultProfiles` matches that exact string to recognize a
 * hatch stub and delete it (which is what re-enables the profile). Clearing
 * it here would strand those installs with `cost-optimized` disabled. Once
 * that pass removes the stub, the code label applies.
 */
export const clearRenamedCostProfileLabelMigration: WorkspaceMigration = {
  id: "139-clear-renamed-cost-profile-label",
  description:
    'Clear the seeded "Speed" label on cost-optimized so the code catalog label applies',
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    // Read outside the parse catch: a transient filesystem error must reach
    // the runner so the migration retries, while malformed JSON is a
    // permanent state this migration cannot repair.
    const rawText = readFileSync(configPath, "utf-8");

    let config: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      config = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    const llm = readObject(config.llm);
    if (llm === null) {
      return;
    }
    const profiles = readObject(llm.profiles);
    if (profiles === null) {
      return;
    }
    const entry = readObject(profiles["cost-optimized"]);
    if (entry === null) {
      return;
    }
    // Only a managed-source entry carries a machinery-written label. Anything
    // else, a source-less legacy entry included, shadows the default outright
    // (see `getEffectiveProfile`), so its label is the user's.
    if (entry.source !== "managed") {
      return;
    }
    if (entry.label !== "Speed") {
      return;
    }

    delete entry.label;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: the label is code-owned once cleared.
  },
};

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
