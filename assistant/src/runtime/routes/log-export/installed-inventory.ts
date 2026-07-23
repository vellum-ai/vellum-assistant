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
 * Every field is *read from already-persisted metadata* — nothing is walked or
 * hashed at export time. Both skills and plugins record an `install-meta.json`
 * sidecar at install carrying `installedAt` and a `v2:<sha256>` whole-tree
 * `contentHash`; this reuses those verbatim:
 *   - `lastUpdated`  ← `install-meta.json` `installedAt` (when the content was
 *     last materialized by install/update).
 *   - `fingerprint`  ← `install-meta.json` `contentHash` (`v2:<sha256>`), the
 *     same value the integrity/diff tooling records.
 * Because the fingerprint is the install-time identity, an in-place edit made
 * after install is *not* reflected here — capturing live drift is the job of
 * `plugins diff`, not this snapshot. Entries with no sidecar (bundled/plugin
 * skills, hand-authored workspace skills, first-party default plugins) report
 * `null` for the fields they don't persist. No file body is ever emitted.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { listAllPlugins } from "../../../cli/lib/list-installed-plugins.js";
import { listInstalledSkills } from "../../../skills/available-skills.js";
import { getLogger } from "../../../util/logger.js";

const log = getLogger("installed-inventory");

const INSTALL_META_FILENAME = "install-meta.json";

/** One installed skill, metadata only. */
export interface SkillInventoryEntry {
  /** Catalog id (directory name). */
  name: string;
  /** `bundled` | `managed` | `workspace` | `extra` | `plugin`. */
  source: string;
  /** Resolved availability: `enabled` | `disabled` | `unavailable`. */
  state: string;
  /** `install-meta.json` `installedAt` (ISO 8601), or `null` when unrecorded. */
  lastUpdated: string | null;
  /** `install-meta.json` `contentHash` (`v2:<sha256>`), or `null`. */
  fingerprint: string | null;
}

/** One installed plugin, metadata only. */
export interface PluginInventoryEntry {
  /** Directory name under `<workspace>/plugins/`. */
  name: string;
  /** `user` (installed) or `default` (first-party). */
  source: string;
  /** `package.json` version (or `install-meta.json` version), or `null`. */
  version: string | null;
  /** True when a `.disabled` sentinel is present. */
  disabled: boolean;
  /** `install-meta.json` `installedAt` (ISO 8601), or `null`. */
  lastUpdated: string | null;
  /** `install-meta.json` `contentHash` (`v2:<sha256>`), or `null`. */
  fingerprint: string | null;
}

export interface InstalledInventory {
  collectedAt: string;
  skills: SkillInventoryEntry[];
  plugins: PluginInventoryEntry[];
  /**
   * Per-section collection failures. Present only when a section could not be
   * enumerated, so an empty `skills`/`plugins` array in the bundle is never
   * ambiguous between "nothing installed" and "collection failed".
   */
  errors?: { skills?: string; plugins?: string };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Every installed skill with its resolved state, plus the last-updated date and
 * content fingerprint read from its `install-meta.json`. Sorted by name.
 *
 * `listInstalledSkills` already reads each skill's install metadata, so the
 * date/fingerprint come for free — no directory walk or re-hash here.
 */
export async function collectSkillInventory(): Promise<SkillInventoryEntry[]> {
  const skills = await listInstalledSkills();
  const entries = skills.map((skill): SkillInventoryEntry => {
    const meta = skill.installMeta ?? null;
    return {
      name: skill.id,
      source: skill.source ?? "unknown",
      state: skill.state,
      lastUpdated: meta?.installedAt ?? null,
      fingerprint: meta?.contentHash ?? null,
    };
  });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

interface StoredPluginMeta {
  installedAt: string | null;
  contentHash: string | null;
  version: string | null;
}

/**
 * Read the three inventory fields from a plugin's `install-meta.json` sidecar.
 * Leniently mirrors `list-installed-plugins`' own install-date read (any parse
 * problem or missing file degrades to nulls) rather than the strict
 * `readInstallMeta`, so a plugin installed through any path still contributes
 * whatever it persisted. One small file read; no directory walk.
 */
function readStoredPluginMeta(pluginDir: string): StoredPluginMeta {
  const empty: StoredPluginMeta = {
    installedAt: null,
    contentHash: null,
    version: null,
  };
  const metaPath = join(pluginDir, INSTALL_META_FILENAME);
  if (!existsSync(metaPath)) {
    return empty;
  }
  try {
    const raw = JSON.parse(readFileSync(metaPath, "utf8")) as Record<
      string,
      unknown
    >;
    const str = (value: unknown): string | null =>
      typeof value === "string" && value.length > 0 ? value : null;
    return {
      installedAt: str(raw.installedAt),
      contentHash: str(raw.contentHash),
      version: str(raw.version),
    };
  } catch {
    return empty;
  }
}

/**
 * Every installed plugin (user + first-party default) with its version,
 * disabled state, and the last-updated date + content fingerprint read from its
 * `install-meta.json`. Sorted by name.
 *
 * First-party defaults live in the app build and carry no sidecar, so they
 * report their manifest version with `null` date/fingerprint.
 */
export function collectPluginInventory(): PluginInventoryEntry[] {
  const entries = listAllPlugins().map((plugin): PluginInventoryEntry => {
    const meta = readStoredPluginMeta(plugin.target);
    return {
      name: plugin.name,
      source: plugin.source,
      version: plugin.packageJson?.version ?? meta.version,
      disabled: plugin.disabled,
      lastUpdated: meta.installedAt,
      fingerprint: meta.contentHash,
    };
  });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/**
 * Assemble the full inventory. Each half is collected independently; a failure
 * enumerating one is recorded in `errors` (and its array left empty) rather
 * than swallowed, so a section that could not be read is never mistaken for a
 * section with nothing installed. Never throws.
 */
export async function collectInstalledInventory(): Promise<InstalledInventory> {
  const errors: { skills?: string; plugins?: string } = {};
  let skills: SkillInventoryEntry[] = [];
  let plugins: PluginInventoryEntry[] = [];
  try {
    skills = await collectSkillInventory();
  } catch (err) {
    errors.skills = errorMessage(err);
    log.warn({ err }, "Failed to collect skill inventory for export");
  }
  try {
    plugins = collectPluginInventory();
  } catch (err) {
    errors.plugins = errorMessage(err);
    log.warn({ err }, "Failed to collect plugin inventory for export");
  }
  const inventory: InstalledInventory = {
    collectedAt: new Date().toISOString(),
    skills,
    plugins,
  };
  if (errors.skills !== undefined || errors.plugins !== undefined) {
    inventory.errors = errors;
  }
  return inventory;
}
