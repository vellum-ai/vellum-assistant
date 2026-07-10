/**
 * Conversation-time projection of active skill tools.
 *
 * On each agent turn the conversation history (and any pre-activated IDs from
 * config or programmatic injection) determine which skills are "active".  This module
 * computes the union, loads tool manifests, registers new skill tools, tears
 * down tools for skills that are no longer active, and returns the projected
 * tool definitions so the agent loop can include them in the next request.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import { skillFlagKey } from "../config/skill-state.js";
import type { SkillSummary, SkillToolManifest } from "../config/skills.js";
import {
  filterSkillsByEnabledPlugins,
  loadSkillCatalog,
} from "../config/skills.js";
import type { Message, ToolDefinition } from "../providers/types.js";
import type { ActiveSkillEntry } from "../skills/active-skill-tools.js";
import { deriveActiveSkills } from "../skills/active-skill-tools.js";
import { getCachedCatalogSync } from "../skills/catalog-cache.js";
import { readInstallMeta, touchSkillLastUsed } from "../skills/install-meta.js";
import { parseToolManifestFile } from "../skills/tool-manifest.js";
import { computeSkillVersionHash } from "../skills/version-hash.js";
import { recordSkillLoadedEvent } from "../telemetry/skill-loaded-events-store.js";
import {
  getToolOwner,
  peekTool,
  registerSkillTools,
  unregisterSkillTools,
} from "../tools/registry.js";
import { createSkillToolsFromManifest } from "../tools/skills/skill-tool-factory.js";
import type { UsageAttributionSnapshot } from "../usage/attribution.js";
import { toAttributionColumns } from "../usage/attribution.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("conversation-skill-tools");

/**
 * Sentinel "version hash" stored in the previously-active map for skills that
 * are active without a loadable TOOLS.json (instruction-only skills — the
 * common case for catalog installs — or skills whose manifest failed to
 * parse). These entries registered no tools, so teardown paths must skip
 * `unregisterSkillTools` for them to avoid decrementing refcounts held by
 * other conversations.
 */
const NO_TOOLS_VERSION = "__no_tools__";

/**
 * Whether a tracked version-hash entry corresponds to tools that were actually
 * registered. Absent entries and the no-tools sentinel registered nothing, so
 * every teardown path must consult this before calling `unregisterSkillTools`
 * — the registry refcounts, and a spurious unregister would decrement counts
 * held by other conversations. This helper is the single owner of the
 * sentinel check; do not compare against `NO_TOOLS_VERSION` elsewhere.
 */
function hasRegisteredTools(trackedHash: string | undefined): boolean {
  return trackedHash !== undefined && trackedHash !== NO_TOOLS_VERSION;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SkillToolProjection {
  /** Tool definitions to append to the agent's tool list for this turn. */
  toolDefinitions: ToolDefinition[];
  /** Tool names that belong to currently active skills. */
  allowedToolNames: Set<string>;
}

/**
 * Conversation-scoped cache for skill projection. Avoids re-scanning the entire
 * conversation history and re-reading the filesystem on every agent turn.
 *
 * Each conversation should own its own cache instance to prevent cross-conversation
 * state bleed.
 */
export interface SkillProjectionCache {
  /** Cached deriveActiveSkills result. */
  derived?: {
    /** Number of messages in history when this cache was last computed. */
    messageCount: number;
    /** Reference to the first message when cache was computed. Compaction
     *  replaces the first message with a new summary object, so a reference
     *  mismatch signals that history was rewritten even if the count matches. */
    firstMessage: Message | undefined;
    /** IDs already seen — used for deduplication during incremental scans. */
    seenIds: Set<string>;
    /** The accumulated active skill entries. */
    entries: ActiveSkillEntry[];
  };
  /** Cached skill catalog. Invalidated when the conversation is marked stale
   *  (e.g. skill directories changed on disk while a run is in progress). */
  catalog?: SkillSummary[];
}

export interface ProjectSkillToolsOptions {
  /** Skill IDs that should be treated as active regardless of history markers. */
  preactivatedSkillIds?: string[];
  /**
   * Conversation-scoped tracking map of previously active skill IDs to their
   * version hashes (or the no-tools sentinel for active skills without a
   * loadable manifest). Each conversation should own its own map to prevent
   * cross-conversation state bleed when the daemon serves multiple concurrent
   * conversations. When a skill's hash changes between turns, its tools are
   * unregistered and re-registered with the updated definitions.
   */
  previouslyActiveSkillIds?: Map<string, string>;
  /**
   * Conversation-scoped projection cache. When provided, projectSkillTools will
   * avoid redundant deriveActiveSkills scans and loadSkillCatalog filesystem
   * reads across agent turns.
   */
  cache?: SkillProjectionCache;
  /**
   * The conversation's effective per-chat plugin scope from
   * `getEffectiveEnabledPluginSet`. `null`/absent means no per-chat restriction
   * (all globally-enabled plugins apply). When a set is given, plugin-owned
   * skills whose owning plugin id is outside it are dropped from this
   * conversation's resolution; non-plugin skills are unaffected.
   */
  effectiveEnabledPluginSet?: Set<string> | null;
  /** Telemetry context for skill_loaded events; absent disables recording. */
  telemetry?: {
    conversationId: string;
    attribution: UsageAttributionSnapshot | null;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Load and parse a skill's TOOLS.json manifest, returning null on any failure.
 */
function loadManifestForSkill(skill: SkillSummary): SkillToolManifest | null {
  const manifestPath = join(skill.directoryPath, "TOOLS.json");
  if (!existsSync(manifestPath)) {
    log.debug(
      { skillId: skill.id, manifestPath },
      "No TOOLS.json found for skill",
    );
    return null;
  }

  try {
    return parseToolManifestFile(manifestPath);
  } catch (err) {
    log.warn(
      { err, skillId: skill.id, manifestPath },
      "Failed to parse TOOLS.json for skill",
    );
    return null;
  }
}

/**
 * Whether a skill is Vellum-produced for `skill_loaded` telemetry purposes:
 * bundled skills always are; managed skills only when their install metadata
 * records a `vellum` origin (legacy version.json installs are inferred as
 * vellum by `readInstallMeta`). All other sources (workspace, extra, plugin)
 * never emit.
 */
function isVellumProducedSkill(skill: SkillSummary): boolean {
  if (skill.source === "bundled") {
    return true;
  }
  if (skill.source === "managed") {
    return readInstallMeta(skill.directoryPath)?.origin === "vellum";
  }
  return false;
}

/**
 * Record a `skill_loaded` telemetry event for a newly-activated Vellum-produced
 * skill. Metadata only — never skill output or conversation content.
 * `skill_updated_at` comes from the cached merged catalog (sync accessor —
 * this runs on the hot tool-projection path). Failures are swallowed at
 * debug level: recording must never break tool projection.
 */
function recordSkillLoadedTelemetry(
  skill: SkillSummary,
  telemetry: ProjectSkillToolsOptions["telemetry"],
): void {
  if (!telemetry) {
    return;
  }
  try {
    if (!isVellumProducedSkill(skill)) {
      return;
    }
    const catalogEntry = getCachedCatalogSync().find((s) => s.id === skill.id);
    recordSkillLoadedEvent({
      conversationId: telemetry.conversationId,
      skillName: skill.id,
      skillUpdatedAt: catalogEntry?.updatedAt,
      ...toAttributionColumns(telemetry.attribution),
    });
  } catch (err) {
    log.debug(
      { err, skillId: skill.id },
      "Failed to record skill_loaded telemetry event (non-fatal)",
    );
  }
}

/**
 * Stamp `lastUsedAt` (day-debounced) on a newly-loaded managed skill's
 * install metadata. Independent of telemetry consent and the
 * `isVellumProducedSkill` gate — those suppress `origin: "custom"` skills,
 * which are exactly the assistant-authored skills the usage-based prune must
 * track. Only managed skills carry install metadata; bundled, workspace, and
 * plugin skills are skipped. Best-effort: the underlying write never throws.
 */
function stampManagedSkillUsage(skill: SkillSummary): void {
  if (skill.source !== "managed") {
    return;
  }
  try {
    const today = new Date().toLocaleDateString("en-CA");
    touchSkillLastUsed(skill.directoryPath, today);
  } catch (err) {
    log.warn(
      { err, skillId: skill.id },
      "Failed to stamp managed-skill lastUsedAt (non-fatal)",
    );
  }
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/**
 * Return active skill entries, using the projection cache when available.
 *
 * History is append-only within a conversation (messages are only added, never
 * mutated in place). If history.length hasn't changed since the last scan,
 * the cached result is returned immediately. If new messages were appended,
 * only the delta is scanned and merged. If history shrank (e.g. compression
 * replaced earlier messages), the cache is invalidated and a full rescan
 * is performed.
 */
function getCachedActiveSkills(
  history: Message[],
  cache?: SkillProjectionCache,
): ActiveSkillEntry[] {
  if (!cache) {
    return deriveActiveSkills(history);
  }

  const cached = cache.derived;

  // Fast path: history unchanged since last scan. Both the count and the
  // first message reference must match — compaction can rewrite history
  // without changing the total count.
  if (
    cached &&
    cached.messageCount === history.length &&
    cached.firstMessage === history[0]
  ) {
    return cached.entries;
  }

  // History grew (and first message is unchanged) — scan only the new messages.
  if (
    cached &&
    cached.messageCount < history.length &&
    cached.firstMessage === history[0]
  ) {
    const delta = history.slice(cached.messageCount);
    const newEntries = deriveActiveSkills(delta);

    // Merge: add any entries not already seen.
    let changed = false;
    for (const entry of newEntries) {
      if (!cached.seenIds.has(entry.id)) {
        cached.seenIds.add(entry.id);
        cached.entries.push(entry);
        changed = true;
      }
    }

    cached.messageCount = history.length;
    if (changed) {
      log.debug(
        { newEntries: newEntries.length, total: cached.entries.length },
        "Incremental skill derivation found new entries",
      );
    }
    return cached.entries;
  }

  // History shrank, compaction rewrote it, or no cache yet — full rescan.
  const entries = deriveActiveSkills(history);
  const seenIds = new Set(entries.map((e) => e.id));
  cache.derived = {
    messageCount: history.length,
    firstMessage: history[0],
    seenIds,
    entries,
  };
  return entries;
}

/**
 * Return the skill catalog, caching it across agent turns.
 *
 * The cache is invalidated when the conversation is marked stale (e.g. skill
 * directories changed on disk while the conversation is still processing).
 */
function getCachedCatalog(cache?: SkillProjectionCache): SkillSummary[] {
  if (!cache) {
    return loadSkillCatalog();
  }

  if (!cache.catalog) {
    cache.catalog = loadSkillCatalog();
  }
  return cache.catalog;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compute the set of active skill tools for the current conversation turn.
 *
 * 1. Derives active skill IDs from conversation history markers.
 * 2. Merges with any preactivated IDs (union).
 * 3. For each newly-active skill, loads its TOOLS.json and registers tools.
 * 4. For each previously-active skill that is no longer active, unregisters.
 * 5. Returns projected tool definitions and the set of allowed tool names.
 */
export function projectSkillTools(
  history: Message[],
  options?: ProjectSkillToolsOptions,
): SkillToolProjection {
  const contextEntries = getCachedActiveSkills(history, options?.cache);
  const preactivated = options?.preactivatedSkillIds ?? [];
  const prevActive =
    options?.previouslyActiveSkillIds ?? new Map<string, string>();

  // Index marker versions by skill ID so we can use them during registration.
  // When a marker carries a version, it records the hash that was active at
  // load time — useful for detecting drift without re-hashing the directory.
  const markerVersionById = new Map<string, string>();
  for (const entry of contextEntries) {
    if (entry.version) {
      markerVersionById.set(entry.id, entry.version);
    }
  }

  // Union of context-derived and preactivated IDs
  const contextIds = contextEntries.map((e) => e.id);
  const allCandidateIds = new Set<string>([...contextIds, ...preactivated]);

  // Load the catalog (cached for conversation lifetime), then scope it to the
  // conversation's per-chat plugin selection so plugin-contributed skills from
  // unselected plugins are not resolvable for this run (null = no restriction).
  const catalog = filterSkillsByEnabledPlugins(
    getCachedCatalog(options?.cache),
    options?.effectiveEnabledPluginSet ?? null,
  );
  const catalogById = new Map<string, SkillSummary>();
  for (const skill of catalog) {
    catalogById.set(skill.id, skill);
  }

  // Assistant feature flag gate: drop skills whose flag is explicitly OFF,
  // even if they have markers in conversation history from before the flag was turned off.
  const config = getConfig();
  const activeIds = new Set<string>();
  for (const id of allCandidateIds) {
    const skill = catalogById.get(id);
    const flagKey = skill ? skillFlagKey(skill) : undefined;
    if (!flagKey || isAssistantFeatureFlagEnabled(flagKey, config)) {
      activeIds.add(id);
    }
  }

  // Determine which skills were removed since last projection
  const removedIds = new Set<string>();
  for (const id of prevActive.keys()) {
    if (!activeIds.has(id)) {
      removedIds.add(id);
    }
  }

  // Unregister tools for skills that are no longer active. Skills tracked
  // with the no-tools sentinel never registered anything — skip them so we
  // don't decrement refcounts held by other conversations.
  for (const id of removedIds) {
    if (!hasRegisteredTools(prevActive.get(id))) {
      continue;
    }
    log.info({ skillId: id }, "Unregistering tools for deactivated skill");
    unregisterSkillTools(id);
  }

  // Early exit if nothing is active
  if (activeIds.size === 0) {
    prevActive.clear();
    return { toolDefinitions: [], allowedToolNames: new Set() };
  }

  // Tool definitions are no longer sent to the LLM — tools are invoked via skill_execute dispatch.
  const allToolNames = new Set<string>();
  const successfulEntries = new Map<string, string>();
  // Track skills already unregistered in the version-change branch so the
  // transiently-failed cleanup loop doesn't double-decrement their refcount.
  const alreadyUnregistered = new Set<string>();

  for (const skillId of activeIds) {
    const skill = catalogById.get(skillId);
    if (!skill) {
      log.warn({ skillId }, "Active skill ID not found in catalog");
      continue;
    }

    // A skill that newly became active counts as one `skill_loaded`, whether
    // or not it ships a TOOLS.json — instruction-only skills (the common case
    // for catalog installs) must be counted too. The event is recorded only
    // once the skill lands in `successfulEntries`, so a failed registration
    // is retried (and counted) on a later turn instead of emitting one row
    // per failing turn. The once-per-activation guard (`prevActive`) is
    // in-memory per-conversation state: after conversation disposal or a
    // daemon restart, re-projection re-emits skill_loaded for already-active
    // skills. That is intentional — a re-load after restart is a load.
    // Downstream consumers that need activation-level uniqueness dedup on
    // (conversation_id, skill_name).
    const prevHash = prevActive.get(skillId);

    const manifest = loadManifestForSkill(skill);
    if (!manifest) {
      // No loadable manifest — nothing to register, but keep tracking the
      // activation so it isn't re-recorded every turn. If tools were
      // registered on a previous turn (manifest removed or corrupted since),
      // tear them down like the transiently-failed path would.
      if (hasRegisteredTools(prevHash)) {
        log.info(
          { skillId },
          "Unregistering tools for skill whose manifest is no longer loadable",
        );
        unregisterSkillTools(skillId);
      }
      successfulEntries.set(skillId, NO_TOOLS_VERSION);
      if (prevHash === undefined) {
        recordSkillLoadedTelemetry(skill, options?.telemetry);
        stampManagedSkillUsage(skill);
      }
      continue;
    }

    // Compute the current version hash for this skill directory
    let currentHash: string;
    try {
      currentHash = computeSkillVersionHash(skill.directoryPath);
    } catch (err) {
      log.warn(
        { err, skillId },
        "Failed to compute skill version hash, treating as changed",
      );
      currentHash = `unknown-${Date.now()}`;
    }

    // Create runtime Tool objects
    const tools = createSkillToolsFromManifest(
      manifest.tools,
      skill.directoryPath,
      currentHash,
      skill.bundled,
    );

    if (tools.length > 0) {
      let accepted = tools;
      if (!hasRegisteredTools(prevHash)) {
        // Newly active skill, or a previously manifest-less activation whose
        // TOOLS.json has since appeared — register for the first time. There
        // is nothing to unregister in the sentinel case: no tools were ever
        // registered for it.
        try {
          accepted = registerSkillTools(skillId, tools);
        } catch (err) {
          log.error({ err, skillId }, "Failed to register skill tools");
          // Not added to successfulEntries — registration (and the
          // skill_loaded record below) is retried next turn.
          continue;
        }
        // A first successful registration counts as the load; a manifest-less
        // activation gaining a TOOLS.json re-registers, which — like a
        // version-hash change — counts as a new load.
        recordSkillLoadedTelemetry(skill, options?.telemetry);
        stampManagedSkillUsage(skill);
      } else if (prevHash !== currentHash) {
        // Hash changed — unregister stale tools, then re-register with new definitions
        log.info(
          { skillId, prevHash, currentHash },
          "Skill version changed, re-registering tools",
        );
        unregisterSkillTools(skillId);
        alreadyUnregistered.add(skillId);
        try {
          accepted = registerSkillTools(skillId, tools);
        } catch (err) {
          log.error(
            { err, skillId },
            "Failed to re-register skill tools after version change",
          );
          // Don't add to successfulEntries — will be cleaned up as transiently-failed
          continue;
        }
        // A version change that re-registers counts as a new skill load.
        recordSkillLoadedTelemetry(skill, options?.telemetry);
        stampManagedSkillUsage(skill);
      } else {
        // Hash unchanged — filter to only tools that are actually registered
        // for this skill. Some tools may have been skipped during initial
        // registration due to core-name collisions — don't let them leak
        // back in. Bundled-status drift no longer requires re-registration
        // because the permission checker derives bundled state from the
        // live catalog instead of a stamped tool field.
        accepted = tools.filter((t) => {
          if (peekTool(t.name) === undefined) {
            return false;
          }
          const owner = getToolOwner(t.name);
          return owner?.kind === "skill" && owner.id === skillId;
        });
      }

      successfulEntries.set(skillId, currentHash);
      for (const tool of accepted) {
        allToolNames.add(tool.name);
      }
    }
  }

  // Unregister skills that were previously active but failed processing this
  // turn (catalog miss, manifest failure, empty tools). Without this, the
  // skill would be re-registered when it recovers next turn, inflating the
  // refcount since the prior registration was never decremented.
  for (const id of prevActive.keys()) {
    if (
      activeIds.has(id) &&
      !successfulEntries.has(id) &&
      !alreadyUnregistered.has(id) &&
      // Sentinel entries registered no tools — nothing to unregister.
      hasRegisteredTools(prevActive.get(id))
    ) {
      log.info(
        { skillId: id },
        "Unregistering tools for transiently-failed skill",
      );
      unregisterSkillTools(id);
    }
  }

  // Update the conversation-scoped tracking map in-place — only include skills
  // that were successfully processed so failed skills can be retried next turn.
  prevActive.clear();
  for (const [id, hash] of successfulEntries) {
    prevActive.set(id, hash);
  }

  return {
    toolDefinitions: [],
    allowedToolNames: allToolNames,
  };
}

/**
 * Reset the projection state and unregister all skill tools tracked in the
 * given map. Used for conversation teardown and tests.
 */
export function resetSkillToolProjection(
  trackedIds?: Map<string, string>,
): void {
  if (trackedIds) {
    for (const [id, hash] of trackedIds) {
      // Sentinel entries (active skills without a manifest) registered no
      // tools — skip them so we don't decrement refcounts held by other
      // conversations.
      if (!hasRegisteredTools(hash)) {
        continue;
      }
      unregisterSkillTools(id);
    }
    trackedIds.clear();
  }
}
