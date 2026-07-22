/**
 * Installed skills + plugins inventory for the support export.
 *
 * A diagnostic support bundle (`POST /v1/export`) needs to answer "what was
 * installed, and at what version" without shipping the skill/plugin *contents*
 * (those are user-authored material the workspace allowlist deliberately keeps
 * out — see `AGENTS.md`). This module produces a metadata-only summary: for
 * each installed skill and plugin, its name, last-updated date, and a content
 * fingerprint. That is enough to tell, from a bundle alone, which skills/plugins
 * a session actually had and whether two environments are running the same
 * bytes — the exact question that is otherwise guessed at.
 *
 * Every field is derived (names, ISO dates, hashes); no file body is emitted.
 * The fingerprints reuse the system's own canonical content hashes so an export
 * value can be compared directly against install metadata and reload logs:
 *   - skills  → `computeSkillVersionHash` (`v1:<sha256>`), the same scheme the
 *     skill catalog records.
 *   - plugins → `computeContentHash` (`v2:<sha256>`), the same scheme a plugin
 *     records in its `install-meta.json` `contentHash`.
 * Both hashes exclude runtime-owned / provenance files, and `lastUpdated`
 * applies the matching exclusions to its mtime scan, so a daily `lastUsedAt`
 * stamp or a `data/` write never moves either signal on its own.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { listAllPlugins } from "../../../cli/lib/list-installed-plugins.js";
import { computeContentHash } from "../../../cli/lib/plugin-fingerprint.js";
import { getConfig } from "../../../config/loader.js";
import { resolveSkillStates } from "../../../config/skill-state.js";
import { loadSkillCatalog } from "../../../config/skills.js";
import {
  PRESERVED_ENTRIES,
  walkPluginTree,
} from "../../../plugins/plugin-tree-walk.js";
import { computeSkillVersionHash } from "../../../skills/version-hash.js";
import { getLogger } from "../../../util/logger.js";

const log = getLogger("installed-inventory");

/**
 * Top-level files excluded from a skill's `lastUpdated` mtime scan, mirroring
 * the exclusions baked into `computeSkillVersionHash` so a daily `lastUsedAt`
 * stamp (written into `install-meta.json`) does not read as a content change.
 */
const SKILL_MTIME_EXCLUDED_ENTRIES: readonly string[] = [
  "install-meta.json",
  "version.json",
];

/** One installed skill, metadata only. */
export interface SkillInventoryEntry {
  /** Catalog id (directory name). */
  name: string;
  /** `bundled` | `managed` | `workspace` | `extra` | `plugin`. */
  source: string;
  /** Resolved availability: `enabled` | `disabled` | `unavailable`. */
  state: string;
  /** ISO 8601 mtime of the newest source file, or `null` if none readable. */
  lastUpdated: string | null;
  /** `computeSkillVersionHash` output (`v1:<sha256>`), or `null` on failure. */
  fingerprint: string | null;
}

/** One installed plugin, metadata only. */
export interface PluginInventoryEntry {
  /** Directory name under `<workspace>/plugins/`. */
  name: string;
  /** `user` (installed) or `default` (first-party). */
  source: string;
  /** `package.json` version, or `null` when absent/unparseable. */
  version: string | null;
  /** True when a `.disabled` sentinel is present. */
  disabled: boolean;
  /** ISO 8601 mtime of the newest source file, or `null`. */
  lastUpdated: string | null;
  /** `computeContentHash` output (`v2:<sha256>`), or `null` when not applicable. */
  fingerprint: string | null;
}

export interface InstalledInventory {
  collectedAt: string;
  skills: SkillInventoryEntry[];
  plugins: PluginInventoryEntry[];
}

function toIso(mtimeMs: number | null): string | null {
  return mtimeMs === null ? null : new Date(mtimeMs).toISOString();
}

/**
 * Newest mtime (ms) across a directory tree, honoring the same exclusions as
 * the corresponding content hash so `lastUpdated` tracks source edits only.
 * Best-effort: unreadable entries and a missing directory yield `null`.
 */
function latestMtimeMs(
  dir: string,
  excludeRootEntries: readonly string[],
): number | null {
  let newest: number | null = null;
  walkPluginTree(
    dir,
    { excludeRootEntries, excludeDotEntries: true, bestEffort: true },
    (_rel, abs) => {
      try {
        const { mtimeMs } = statSync(abs);
        if (newest === null || mtimeMs > newest) {
          newest = mtimeMs;
        }
      } catch {
        // Raced deletion between walk and stat — the newest surviving file wins.
      }
    },
  );
  return newest;
}

/**
 * Every installed skill with its resolved state, last-updated date, and content
 * fingerprint. Sorted by name. Filesystem/config only — no DB access.
 */
export function collectSkillInventory(): SkillInventoryEntry[] {
  const catalog = loadSkillCatalog();
  const stateById = new Map(
    resolveSkillStates(catalog, getConfig()).map((r) => [
      r.summary.id,
      r.state,
    ]),
  );

  const entries = catalog.map((summary): SkillInventoryEntry => {
    let fingerprint: string | null = null;
    try {
      fingerprint = computeSkillVersionHash(summary.directoryPath);
    } catch (err) {
      log.warn(
        { err, skill: summary.id },
        "Failed to fingerprint skill for inventory; emitting null",
      );
    }
    return {
      name: summary.id,
      source: summary.source,
      // resolveSkillStates omits flag-gated / disallowed-bundled skills; those
      // are surfaced as `unavailable` rather than dropped, so the inventory
      // still enumerates the full installed universe.
      state: stateById.get(summary.id) ?? "unavailable",
      lastUpdated: toIso(
        latestMtimeMs(summary.directoryPath, SKILL_MTIME_EXCLUDED_ENTRIES),
      ),
      fingerprint,
    };
  });

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/**
 * Every installed plugin (user + first-party default) with its version,
 * disabled state, last-updated date, and content fingerprint. Sorted by name.
 *
 * A fingerprint and `lastUpdated` are computed only when the plugin directory
 * holds real source (a `package.json`): first-party defaults live in the app
 * build and expose only a workspace stub, so hashing that stub would be
 * meaningless — those entries carry a `null` fingerprint and their manifest
 * version instead.
 */
export function collectPluginInventory(): PluginInventoryEntry[] {
  const entries = listAllPlugins().map((plugin): PluginInventoryEntry => {
    const hasSource = existsSync(join(plugin.target, "package.json"));
    let fingerprint: string | null = null;
    let lastUpdated: string | null = null;
    if (hasSource) {
      try {
        fingerprint = computeContentHash(plugin.target, [...PRESERVED_ENTRIES]);
      } catch (err) {
        log.warn(
          { err, plugin: plugin.name },
          "Failed to fingerprint plugin for inventory; emitting null",
        );
      }
      lastUpdated = toIso(latestMtimeMs(plugin.target, [...PRESERVED_ENTRIES]));
    }
    return {
      name: plugin.name,
      source: plugin.source,
      version: plugin.packageJson?.version ?? null,
      disabled: plugin.disabled,
      lastUpdated,
      fingerprint,
    };
  });

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/**
 * Assemble the full inventory. Each half is collected independently so a
 * failure enumerating one (e.g. a corrupt skill catalog) still yields the
 * other rather than an empty file. Never throws.
 */
export function collectInstalledInventory(): InstalledInventory {
  let skills: SkillInventoryEntry[] = [];
  let plugins: PluginInventoryEntry[] = [];
  try {
    skills = collectSkillInventory();
  } catch (err) {
    log.warn({ err }, "Failed to collect skill inventory for export");
  }
  try {
    plugins = collectPluginInventory();
  } catch (err) {
    log.warn({ err }, "Failed to collect plugin inventory for export");
  }
  return { collectedAt: new Date().toISOString(), skills, plugins };
}
