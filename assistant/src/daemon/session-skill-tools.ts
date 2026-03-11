/**
 * Session-time projection of active skill tools.
 *
 * On each agent turn the conversation history (and any pre-activated IDs from
 * config or slash commands) determine which skills are "active".  This module
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
import { loadSkillCatalog } from "../config/skills.js";
import type { Message, ToolDefinition } from "../providers/types.js";
import type { ActiveSkillEntry } from "../skills/active-skill-tools.js";
import { deriveActiveSkills } from "../skills/active-skill-tools.js";
import { parseToolManifestFile } from "../skills/tool-manifest.js";
import { computeSkillVersionHash } from "../skills/version-hash.js";
import {
  getTool,
  registerSkillTools,
  unregisterSkillTools,
} from "../tools/registry.js";
import { createSkillToolsFromManifest } from "../tools/skills/skill-tool-factory.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("session-skill-tools");

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
 * Session-scoped cache for skill projection. Avoids re-scanning the entire
 * conversation history and re-reading the filesystem on every agent turn.
 *
 * Each session should own its own cache instance to prevent cross-session
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
  /** Cached skill catalog. Invalidated when the session is marked stale
   *  (e.g. skill directories changed on disk while a run is in progress). */
  catalog?: SkillSummary[];
}

export interface ProjectSkillToolsOptions {
  /** Skill IDs that should be treated as active regardless of history markers. */
  preactivatedSkillIds?: string[];
  /**
   * Session-scoped tracking map of previously active skill IDs to their
   * version hashes. Each session should own its own map to prevent
   * cross-session state bleed when the daemon serves multiple concurrent
   * sessions. When a skill's hash changes between turns, its tools are
   * unregistered and re-registered with the updated definitions.
   */
  previouslyActiveSkillIds?: Map<string, string>;
  /**
   * Session-scoped projection cache. When provided, projectSkillTools will
   * avoid redundant deriveActiveSkills scans and loadSkillCatalog filesystem
   * reads across agent turns.
   */
  cache?: SkillProjectionCache;
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

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/**
 * Return active skill entries, using the projection cache when available.
 *
 * History is append-only within a session (messages are only added, never
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
  if (!cache) return deriveActiveSkills(history);

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
 * The cache is invalidated when the session is marked stale (e.g. skill
 * directories changed on disk while the session is still processing).
 */
function getCachedCatalog(cache?: SkillProjectionCache): SkillSummary[] {
  if (!cache) return loadSkillCatalog();

  if (!cache.catalog) {
    cache.catalog = loadSkillCatalog();
  }
  return cache.catalog;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compute the set of active skill tools for the current session turn.
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

  // Load the catalog (cached for session lifetime) and index by ID
  const catalog = getCachedCatalog(options?.cache);
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

  // Unregister tools for skills that are no longer active
  for (const id of removedIds) {
    log.info({ skillId: id }, "Unregistering tools for deactivated skill");
    unregisterSkillTools(id);
  }

  // Early exit if nothing is active
  if (activeIds.size === 0) {
    prevActive.clear();
    return { toolDefinitions: [], allowedToolNames: new Set() };
  }

  const allToolDefinitions: ToolDefinition[] = [];
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

    const manifest = loadManifestForSkill(skill);
    if (!manifest) {
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
      skillId,
      skill.directoryPath,
      currentHash,
      skill.bundled,
    );

    if (tools.length > 0) {
      let accepted = tools;
      const prevHash = prevActive.get(skillId);
      if (prevHash === undefined) {
        // Newly active skill — register for the first time
        accepted = registerSkillTools(tools);
      } else if (prevHash !== currentHash) {
        // Hash changed — unregister stale tools, then re-register with new definitions
        log.info(
          { skillId, prevHash, currentHash },
          "Skill version changed, re-registering tools",
        );
        unregisterSkillTools(skillId);
        alreadyUnregistered.add(skillId);
        try {
          accepted = registerSkillTools(tools);
        } catch (err) {
          log.error(
            { err, skillId },
            "Failed to re-register skill tools after version change",
          );
          // Don't add to successfulEntries — will be cleaned up as transiently-failed
          continue;
        }
      } else {
        // Hash unchanged — check if the bundled status drifted (e.g. a
        // managed skill override was added/removed with identical content).
        // Re-register so the ownerSkillBundled flag stays accurate.
        const existing = getTool(tools[0].name);
        if (
          existing &&
          existing.ownerSkillBundled !== (skill.bundled ?? undefined)
        ) {
          log.info(
            { skillId, bundled: skill.bundled },
            "Skill bundled status changed, re-registering tools",
          );
          unregisterSkillTools(skillId);
          accepted = registerSkillTools(tools);
        } else {
          // Filter to only tools that are actually registered for this skill.
          // Some tools may have been skipped during initial registration due
          // to core-name collisions — don't let them leak back in.
          accepted = tools.filter((t) => {
            const reg = getTool(t.name);
            return (
              reg !== undefined &&
              reg.origin === "skill" &&
              reg.ownerSkillId === skillId
            );
          });
        }
      }

      successfulEntries.set(skillId, currentHash);
      for (const tool of accepted) {
        allToolDefinitions.push(tool.getDefinition());
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
      !alreadyUnregistered.has(id)
    ) {
      log.info(
        { skillId: id },
        "Unregistering tools for transiently-failed skill",
      );
      unregisterSkillTools(id);
    }
  }

  // Update the session-scoped tracking map in-place — only include skills
  // that were successfully processed so failed skills can be retried next turn.
  prevActive.clear();
  for (const [id, hash] of successfulEntries) {
    prevActive.set(id, hash);
  }

  return {
    toolDefinitions: allToolDefinitions,
    allowedToolNames: allToolNames,
  };
}

/**
 * Reset the projection state and unregister all skill tools tracked in the
 * given map. Used for session teardown and tests.
 */
export function resetSkillToolProjection(
  trackedIds?: Map<string, string>,
): void {
  if (trackedIds) {
    for (const id of trackedIds.keys()) {
      unregisterSkillTools(id);
    }
    trackedIds.clear();
  }
}
