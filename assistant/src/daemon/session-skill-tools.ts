/**
 * Session-time projection of active skill tools.
 *
 * On each agent turn the conversation history (and any pre-activated IDs from
 * config or slash commands) determine which skills are "active".  This module
 * computes the union, loads tool manifests, registers new skill tools, tears
 * down tools for skills that are no longer active, and returns the projected
 * tool definitions so the agent loop can include them in the next request.
 */

import type { Message, ToolDefinition } from '../providers/types.js';
import type { SkillSummary, SkillToolManifest } from '../config/skills.js';
import { loadSkillCatalog } from '../config/skills.js';
import { deriveActiveSkillIds } from '../skills/active-skill-tools.js';
import { parseToolManifestFile } from '../skills/tool-manifest.js';
import { createSkillToolsFromManifest } from '../tools/skills/skill-tool-factory.js';
import {
  registerSkillTools,
  unregisterSkillTools,
} from '../tools/registry.js';
import { getLogger } from '../util/logger.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const log = getLogger('session-skill-tools');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SkillToolProjection {
  /** Tool definitions to append to the agent's tool list for this turn. */
  toolDefinitions: ToolDefinition[];
  /** Tool names that belong to currently active skills. */
  allowedToolNames: Set<string>;
}

export interface ProjectSkillToolsOptions {
  /** Skill IDs that should be treated as active regardless of history markers. */
  preactivatedSkillIds?: string[];
  /**
   * Session-scoped tracking set of previously active skill IDs. Each session
   * should own its own set to prevent cross-session state bleed when the
   * daemon serves multiple concurrent sessions.
   */
  previouslyActiveSkillIds?: Set<string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Load and parse a skill's TOOLS.json manifest, returning null on any failure.
 */
function loadManifestForSkill(skill: SkillSummary): SkillToolManifest | null {
  const manifestPath = join(skill.directoryPath, 'TOOLS.json');
  if (!existsSync(manifestPath)) {
    log.debug({ skillId: skill.id, manifestPath }, 'No TOOLS.json found for skill');
    return null;
  }

  try {
    return parseToolManifestFile(manifestPath);
  } catch (err) {
    log.warn({ err, skillId: skill.id, manifestPath }, 'Failed to parse TOOLS.json for skill');
    return null;
  }
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
  const contextIds = deriveActiveSkillIds(history);
  const preactivated = options?.preactivatedSkillIds ?? [];
  const prevActive = options?.previouslyActiveSkillIds ?? new Set<string>();

  // Union of context-derived and preactivated IDs
  const activeIds = new Set<string>([...contextIds, ...preactivated]);

  // Determine which skills were removed since last projection
  const removedIds = new Set<string>();
  for (const id of prevActive) {
    if (!activeIds.has(id)) {
      removedIds.add(id);
    }
  }

  // Unregister tools for skills that are no longer active
  for (const id of removedIds) {
    log.info({ skillId: id }, 'Unregistering tools for deactivated skill');
    unregisterSkillTools(id);
  }

  // Early exit if nothing is active
  if (activeIds.size === 0) {
    prevActive.clear();
    return { toolDefinitions: [], allowedToolNames: new Set() };
  }

  // Load the catalog once and index by ID for efficient lookup
  const catalog = loadSkillCatalog();
  const catalogById = new Map<string, SkillSummary>();
  for (const skill of catalog) {
    catalogById.set(skill.id, skill);
  }

  const allToolDefinitions: ToolDefinition[] = [];
  const allToolNames = new Set<string>();

  for (const skillId of activeIds) {
    const skill = catalogById.get(skillId);
    if (!skill) {
      log.warn({ skillId }, 'Active skill ID not found in catalog');
      continue;
    }

    const manifest = loadManifestForSkill(skill);
    if (!manifest) {
      continue;
    }

    // Create runtime Tool objects — only register if this skill is newly active
    // to avoid inflating the registry refcount on every turn.
    const tools = createSkillToolsFromManifest(
      manifest.tools,
      skillId,
      skill.directoryPath,
    );

    if (tools.length > 0) {
      if (!prevActive.has(skillId)) {
        registerSkillTools(tools);
      }

      for (const tool of tools) {
        allToolDefinitions.push(tool.getDefinition());
        allToolNames.add(tool.name);
      }
    }
  }

  // Update the session-scoped tracking set in-place
  prevActive.clear();
  for (const id of activeIds) {
    prevActive.add(id);
  }

  return {
    toolDefinitions: allToolDefinitions,
    allowedToolNames: allToolNames,
  };
}

/**
 * Reset the projection state and unregister all skill tools tracked in the
 * given set. Used for session teardown and tests.
 */
export function resetSkillToolProjection(trackedIds?: Set<string>): void {
  if (trackedIds) {
    for (const id of trackedIds) {
      unregisterSkillTools(id);
    }
    trackedIds.clear();
  }
}
