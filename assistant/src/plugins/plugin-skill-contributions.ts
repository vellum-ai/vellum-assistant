/**
 * In-memory registry of plugin-contributed skills.
 *
 * Plugins with `manifest.skills` (or {@link Plugin.skills}) declared in their
 * {@link PluginSkillRegistration} list get their entries indexed here during
 * bootstrap (PR 14 -> PR 33). {@link loadSkillCatalog} in
 * `config/skills.ts` merges these entries into the regular catalog so the
 * model's `skill_load` / `skill_execute` flow can resolve them under
 * `source: "plugin"`.
 *
 * ## Ref-counted lifecycle
 *
 * Registration is per-plugin — a plugin declares zero or more skills and the
 * registry stores them keyed by plugin name. Several tests and hot-reload
 * flows may call {@link registerPluginSkills} more than once for the same
 * plugin (same skills, same body). Each call bumps a reference counter;
 * {@link unregisterPluginSkills} decrements it and only tears the entry down
 * when the counter reaches zero. This mirrors the ref-counted teardown
 * semantics of `registerSkillTools` / `unregisterSkillTools` in the tool
 * registry, so the plugin layer's lifecycle matches the skill layer's.
 *
 * Collision rules:
 *
 * - A plugin cannot register two skills with the same id in a single call —
 *   the duplicate is rejected at registration time.
 * - Two different plugins cannot contribute skills with the same id. The
 *   second registration throws so the operator notices, rather than silently
 *   shadowing the first plugin's contribution.
 * - The catalog merge logic in {@link loadSkillCatalog} decides how plugin
 *   skills interact with filesystem skills (bundled/managed/workspace) —
 *   this module just owns the in-memory set.
 */

import type {
  SkillDefinition,
  SkillSummary,
  SkillToolManifestMeta,
} from "../config/skills.js";
import { getLogger } from "../util/logger.js";
import { PluginExecutionError, type PluginSkillRegistration } from "./types.js";

// This module imports ONLY types from `config/skills.js`. `config/skills.ts`
// in turn imports values from here to merge plugin-contributed skills into
// the catalog output. TypeScript / ESM handles the type-only edge of the
// cycle cleanly; converting any of the imports above to value imports would
// introduce a runtime cycle and a load-order hazard with `loadSkillCatalog`.

const log = getLogger("plugin-skills");

/**
 * Virtual directory path prefix for plugin-contributed skills. `SkillSummary`
 * requires a `directoryPath` — plugin skills aren't on disk, so we synthesize
 * a stable, recognizable path that encodes the plugin name. Downstream code
 * that reads from disk (inline-command rendering, reference-file listing,
 * icon caching) gates on `source` so these paths are never stat'd.
 */
const PLUGIN_VIRTUAL_PATH_PREFIX = "<plugin>/";

/**
 * One stored plugin skill. Keeps the original registration for re-exposure
 * and a pre-built {@link SkillDefinition} so the catalog / loader paths can
 * return summary/definition objects without re-synthesizing them on every
 * lookup.
 */
interface StoredPluginSkill {
  /** Name of the plugin that contributed the skill. */
  pluginName: string;
  /** Pre-built definition (includes the body) returned to `skill_load`. */
  definition: SkillDefinition;
}

/** All skills contributed by plugins, keyed by skill id. */
const pluginSkillsById = new Map<string, StoredPluginSkill>();

/**
 * Ref-count of active registrations per plugin name. Bumped on
 * {@link registerPluginSkills}, decremented on {@link unregisterPluginSkills}.
 * Only when the counter hits zero do we actually remove the plugin's
 * contributed skills from {@link pluginSkillsById}.
 */
const pluginRefCount = new Map<string, number>();

/**
 * Skill-id -> owning plugin name. Maintained alongside
 * {@link pluginSkillsById} so {@link unregisterPluginSkills} can drop exactly
 * the entries the plugin owns without scanning the full id map.
 */
const pluginSkillIdsByPlugin = new Map<string, Set<string>>();

/**
 * Build the {@link SkillDefinition} object that {@link loadSkillCatalog} and
 * {@link loadSkillBySelector} hand back to consumers. Kept in one place so
 * summary and definition stay in lockstep — any field added to
 * {@link PluginSkillRegistration} shows up in both.
 */
function buildDefinition(
  pluginName: string,
  reg: PluginSkillRegistration,
): SkillDefinition {
  // Synthetic directory path. Using a non-filesystem prefix keeps the path
  // recognizable in logs while preventing accidental `fs.existsSync` loops
  // elsewhere in the catalog (all such loops live behind source !== "plugin"
  // guards).
  const directoryPath = `${PLUGIN_VIRTUAL_PATH_PREFIX}${pluginName}/${reg.id}`;
  const skillFilePath = `${directoryPath}/SKILL.md`;

  // toolManifest stays undefined for plugin skills — plugin tool contributions
  // flow through `Plugin.tools` (PR 31), not through a synthetic TOOLS.json.
  const toolManifest: SkillToolManifestMeta | undefined = undefined;

  return {
    id: reg.id,
    name: reg.name,
    displayName: reg.displayName ?? reg.name,
    description: reg.description,
    directoryPath,
    skillFilePath,
    body: reg.body,
    emoji: reg.emoji,
    source: "plugin",
    toolManifest,
    includes: reg.includes,
    featureFlag: reg.featureFlag,
    activationHints: reg.activationHints,
    avoidWhen: reg.avoidWhen,
    // Plugin skills do not support inline command expansion in this PR.
    inlineCommandExpansions: undefined,
  };
}

/**
 * Register every skill declared by a plugin's `Plugin.skills` list.
 *
 * Must be called after the plugin's `init()` completes successfully (see
 * `external-plugins-bootstrap.ts`). Throws {@link PluginExecutionError} if a
 * skill id collides with another plugin's skill or with an id already
 * registered in an earlier successful registration from the same plugin
 * that hasn't been torn down.
 *
 * Ref-count semantics: each call bumps the plugin-level ref counter.
 * Duplicate registrations of the *same* plugin's skills are accepted and
 * treated as a no-op past the first call — the second invocation increments
 * the counter without re-inserting entries.
 */
export function registerPluginSkills(
  pluginName: string,
  skills: readonly PluginSkillRegistration[],
): void {
  const currentCount = pluginRefCount.get(pluginName) ?? 0;

  if (currentCount > 0) {
    // The plugin already has skills registered — bump the counter without
    // re-adding. Duplicate register calls for the same plugin are legitimate
    // (hot-reload, re-bootstrap) so we accept them rather than throw.
    pluginRefCount.set(pluginName, currentCount + 1);
    log.debug(
      { pluginName, refCount: currentCount + 1 },
      "Bumped plugin-skills ref count (skills kept)",
    );
    return;
  }

  // First-time registration for this plugin — validate and insert.
  //
  // We validate intra-batch uniqueness first so a plugin that accidentally
  // declares the same skill twice gets a clear error at registration,
  // rather than the second declaration silently overwriting the first
  // inside the map.
  const seenInBatch = new Set<string>();
  for (const reg of skills) {
    if (seenInBatch.has(reg.id)) {
      throw new PluginExecutionError(
        `plugin ${pluginName} declared skill "${reg.id}" more than once`,
        pluginName,
      );
    }
    seenInBatch.add(reg.id);

    const existing = pluginSkillsById.get(reg.id);
    if (existing) {
      throw new PluginExecutionError(
        `plugin ${pluginName} cannot contribute skill "${reg.id}" — ` +
          `already registered by plugin "${existing.pluginName}"`,
        pluginName,
      );
    }
  }

  const ownedIds = new Set<string>();
  for (const reg of skills) {
    pluginSkillsById.set(reg.id, {
      pluginName,
      definition: buildDefinition(pluginName, reg),
    });
    ownedIds.add(reg.id);
    log.info({ pluginName, skillId: reg.id }, "Plugin skill registered");
  }

  pluginSkillIdsByPlugin.set(pluginName, ownedIds);
  pluginRefCount.set(pluginName, 1);
}

/**
 * Decrement the ref count for a plugin's skills. When the count hits zero
 * the plugin's contributed skills are removed from the in-memory catalog.
 *
 * Idempotent — calling on a plugin that was never registered is a no-op
 * (logged at debug level).
 */
export function unregisterPluginSkills(pluginName: string): void {
  const current = pluginRefCount.get(pluginName) ?? 0;
  if (current === 0) {
    log.debug(
      { pluginName },
      "unregisterPluginSkills called on unregistered plugin (no-op)",
    );
    return;
  }

  if (current > 1) {
    pluginRefCount.set(pluginName, current - 1);
    log.info(
      { pluginName, remaining: current - 1 },
      "Decremented plugin-skills ref count, skills kept",
    );
    return;
  }

  // Last reference — actually remove the skills.
  pluginRefCount.delete(pluginName);
  const ownedIds = pluginSkillIdsByPlugin.get(pluginName);
  if (ownedIds) {
    for (const id of ownedIds) {
      pluginSkillsById.delete(id);
      log.info({ pluginName, skillId: id }, "Plugin skill unregistered");
    }
    pluginSkillIdsByPlugin.delete(pluginName);
  }
}

/**
 * Return a shallow-copied list of {@link SkillSummary} entries for every
 * plugin-contributed skill. Consumers (the catalog loader) treat the return
 * value as a read-only snapshot — mutating it does not mutate the registry.
 */
export function getPluginContributedSkillSummaries(): SkillSummary[] {
  const out: SkillSummary[] = [];
  for (const stored of pluginSkillsById.values()) {
    // Strip `body` so we hand out a SkillSummary, not a SkillDefinition —
    // the catalog merge function in config/skills.ts pushes summaries.
    const { body: _body, ...summary } = stored.definition;
    out.push(summary);
  }
  return out;
}

/**
 * Look up the full {@link SkillDefinition} for a plugin-contributed skill by
 * id. Used by the catalog loader to satisfy `skill_load` without a disk
 * read.
 */
export function getPluginContributedSkillDefinition(
  skillId: string,
): SkillDefinition | undefined {
  return pluginSkillsById.get(skillId)?.definition;
}

/**
 * Return the current ref count for a plugin's skills. Exposed for tests.
 */
export function getPluginSkillRefCount(pluginName: string): number {
  return pluginRefCount.get(pluginName) ?? 0;
}

/**
 * Clear every registered plugin skill. Test-only — throws when invoked
 * outside a test environment. Guard mirrors
 * {@link resetPluginRegistryForTests}.
 */
export function resetPluginSkillContributionsForTests(): void {
  const isTest =
    process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
  if (!isTest) {
    throw new PluginExecutionError(
      "resetPluginSkillContributionsForTests may only be called in test environments",
      undefined,
    );
  }
  pluginSkillsById.clear();
  pluginRefCount.clear();
  pluginSkillIdsByPlugin.clear();
}
