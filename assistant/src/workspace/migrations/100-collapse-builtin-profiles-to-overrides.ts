/**
 * Workspace migration `100-collapse-builtin-profiles-to-overrides`.
 *
 * Built-in inference profiles (`auto`, `balanced`, `quality-optimized`,
 * `cost-optimized`, `balanced-economy`) are now code-defined and merged into
 * the effective config at load time. The legacy seeder (and migrations
 * 052/082/097) materialized full entries for them under `llm.profiles`; the
 * config loader keeps a transition-compat path that treats label/status on
 * those stale entries as low-precedence overrides.
 *
 * This migration collapses the stale materialized entries so the
 * transition-compat path becomes a no-op for migrated installs:
 *
 *   - `status`: lifted into `llm.profileOverrides[name].status` whenever the
 *     key is present on the entry (an explicit `null` lifts as `null`).
 *   - `label`: lifted only when the key is present AND the value is not a
 *     seed-default label for that profile (bare or `" (Managed)"`-suffixed).
 *     Seed-default-equal labels are seed artifacts — dropped so future
 *     template relabels propagate. An explicit `null` lifts as `null`.
 *   - Pre-existing `llm.profileOverrides[name]` fields are never overwritten
 *     (write routes may have landed overrides before this migration runs).
 *   - The entry is deleted from `llm.profiles`. Drifted config fields
 *     (provider/model/maxTokens/thinking/...) are NOT preserved — only
 *     relabel + enablement survive (product decision). A structured warning
 *     lists the dropped keys per profile so drifted installs are diagnosable.
 *
 * `llm.profileOrder` is left untouched — built-in names there remain valid.
 * Idempotent: a second run finds no built-in entries and does not write.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger(
  "workspace-migration-100-collapse-builtin-profiles-to-overrides",
);

/**
 * Built-in profile names and their seed-default labels (bare template label
 * plus the `" (Managed)"`-suffixed form the BYOK-era seeder wrote; `auto`
 * never had a suffixed variant). Duplicated from
 * `config/builtin-inference-profiles.ts` intentionally — migrations are
 * forward-only and self-contained per the workspace migrations AGENTS
 * contract; future template relabels must NOT retroactively change what this
 * migration treats as a seed artifact.
 */
const SEED_DEFAULT_LABELS: Record<string, readonly string[]> = {
  auto: ["Auto"],
  balanced: ["Balanced", "Balanced (Managed)"],
  "quality-optimized": ["Quality", "Quality (Managed)"],
  "cost-optimized": ["Speed", "Speed (Managed)"],
  "balanced-economy": ["Balanced Economy", "Balanced Economy (Managed)"],
};

const BUILTIN_PROFILE_NAMES = Object.keys(SEED_DEFAULT_LABELS);

/**
 * Entry keys that are either lifted (label/status) or pure seeder metadata
 * (source/description). Anything else on a materialized entry is config
 * drift and gets dropped with a warning.
 */
const NON_DRIFT_KEYS = new Set(["label", "status", "source", "description"]);

/** Valid `ProfileOverrideEntry.status` values (schema: active|disabled|null). */
const VALID_STATUSES = new Set<unknown>(["active", "disabled", null]);

export const collapseBuiltinProfilesToOverridesMigration: WorkspaceMigration = {
  id: "100-collapse-builtin-profiles-to-overrides",
  description:
    "Collapse materialized built-in inference profiles into llm.profileOverrides",

  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (err) {
      log.warn(
        { err, path: configPath },
        "Failed to read or parse config.json; skipping migration",
      );
      return;
    }

    const config = readObject(parsed);
    if (!config) return;

    const llm = readObject(config.llm);
    if (!llm) return;

    const profiles = readObject(llm.profiles);
    if (!profiles) return;

    const overrides = readObject(llm.profileOverrides) ?? {};

    let changed = false;

    for (const name of BUILTIN_PROFILE_NAMES) {
      if (!(name in profiles)) continue;

      const entry = readObject(profiles[name]);
      if (entry) {
        const existing = readObject(overrides[name]);
        const override = existing ?? {};

        if (
          "status" in entry &&
          !("status" in override) &&
          VALID_STATUSES.has(entry.status)
        ) {
          override.status = entry.status;
        }

        if ("label" in entry && !("label" in override)) {
          const label = entry.label;
          if (label === null) {
            override.label = null;
          } else if (
            typeof label === "string" &&
            label.length > 0 &&
            !SEED_DEFAULT_LABELS[name]!.includes(label)
          ) {
            override.label = label;
          }
        }

        if (!existing && Object.keys(override).length > 0) {
          overrides[name] = override;
        }

        const droppedKeys = Object.keys(entry).filter(
          (key) => !NON_DRIFT_KEYS.has(key),
        );
        if (droppedKeys.length > 0) {
          log.warn(
            { profile: name, droppedKeys },
            "Dropped config fields from materialized built-in profile while collapsing to profileOverrides; built-in templates are now authoritative",
          );
        }
      }

      delete profiles[name];
      changed = true;
    }

    if (!changed) return;

    if (Object.keys(overrides).length > 0) {
      llm.profileOverrides = overrides;
    }

    try {
      writeFileSync(
        configPath,
        JSON.stringify(config, null, 2) + "\n",
        "utf-8",
      );
      log.info(
        { path: configPath },
        "Collapsed materialized built-in profiles into llm.profileOverrides",
      );
    } catch (err) {
      log.warn(
        { err, path: configPath },
        "Failed to write collapsed config.json; leaving prior file in place",
      );
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: re-materializing built-in entries would resurrect the
    // transition-compat ambiguity this migration exists to remove.
  },
};

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
