import type { SkillSource } from "../../config/skills.js";
import { loadSkillCatalog } from "../../config/skills.js";
import { MEMORY_RETROSPECTIVE_ORIGIN } from "../../plugins/defaults/memory/memory-retrospective-constants.js";
import { nearestExistingSkills } from "../../plugins/defaults/memory/v3/candidate-match.js";
import { readInstallMeta } from "../../skills/install-meta.js";
import {
  getManagedSkillDir,
  readStoredManagedSkill,
  type StoredManagedSkill,
} from "../../skills/managed-store.js";
import {
  filterSkillsByPlatform,
  type SkillPlatform,
} from "../../skills/platform-compatibility.js";
import { throwIfCancelled } from "../shared/abort.js";
import type { OwnerInfo, ToolContext, ToolExecutionResult } from "../types.js";

/**
 * A shortlisted skill enriched with its catalog name, description, and source.
 * `source` lets the caller see whether an existing skill of ANY origin already
 * covers the goal — a bundled/plugin/workspace match (or a person-authored
 * managed one) is not the retrospective's to overwrite or duplicate.
 *
 * `author` is the install-meta provenance of a `source: "managed"` hit
 * (`"assistant"` = a skill the assistant authored and may overwrite;
 * `"user"` = a person wrote it, off-limits). It is undefined for non-managed
 * sources and for managed skills with no recorded author, so the caller can
 * distinguish its OWN managed skills from a user's without re-reading meta.
 *
 * `current` is the skill as stored, present only on a hit the caller may
 * refine (managed, assistant-authored) and only for the retrospective. A
 * refinement is a whole-file overwrite and the pass has no other read path:
 * its `skill_load` grant covers skill-management alone, and loading would
 * stamp `lastUsedAt` and count as usage. Fields are spelled as
 * `scaffold_managed_skill`'s own arguments so the pass carries forward what
 * it is not changing without translating names.
 */
interface EnrichedHit {
  skill_id: string;
  name: string;
  description: string;
  source: SkillSource;
  author?: "assistant" | "user";
  score: number;
  current?: CurrentSkill;
}

/** The refinable skill's present content, in `scaffold_managed_skill` argument names. */
interface CurrentSkill {
  name: string;
  description: string;
  emoji?: string;
  category?: string;
  includes?: string[];
  activation_hints?: string[];
  avoid_when?: string[];
  body_markdown: string;
}

/**
 * Core execution logic for find_similar_skills. Read-only: scores `goal`
 * against the skill catalog's capability pages and returns the nearest skills,
 * each joined to its catalog name/description. Exported so bundled-skill
 * executors and tests can call it directly.
 *
 * `deps` injects the shortlist, catalog, and stored-skill seams so tests run
 * without Qdrant or a skills directory.
 */
export async function executeFindSimilarSkills(
  input: Record<string, unknown>,
  context: ToolContext,
  deps: {
    nearestExistingSkills?: typeof nearestExistingSkills;
    loadCatalog?: () => {
      id: string;
      name: string;
      description: string;
      source: SkillSource;
      owner?: OwnerInfo;
      platforms?: SkillPlatform[];
    }[];
    readStoredManagedSkill?: (skillId: string) => StoredManagedSkill | null;
  } = {},
): Promise<ToolExecutionResult> {
  const goal = input.goal;
  if (typeof goal !== "string" || !goal.trim()) {
    return {
      content: "Error: goal is required and must be a non-empty string",
      isError: true,
    };
  }

  let limit: number | undefined;
  if (input.limit !== undefined) {
    if (
      typeof input.limit !== "number" ||
      !Number.isInteger(input.limit) ||
      input.limit < 1
    ) {
      return {
        content: "Error: limit must be a positive integer",
        isError: true,
      };
    }
    limit = input.limit;
  }

  const findNearest = deps.nearestExistingSkills ?? nearestExistingSkills;
  const loadCatalog = deps.loadCatalog ?? (() => loadSkillCatalog());
  const readStored = deps.readStoredManagedSkill ?? readStoredManagedSkill;

  const catalog = loadCatalog();
  const byId = new Map(catalog.map((s) => [s.id, s]));

  // Per-chat plugin scope: a plugin-owned skill whose owning plugin is outside
  // the conversation's effective set must not be surfaced as a discovery
  // result. `null` = no restriction; non-plugin skills are always retained
  // (mirrors `filterSkillsByEnabledPlugins`).
  const enabledPluginSet = context.enabledPluginSet ?? null;
  const outOfScope = (skill: { owner?: OwnerInfo }): boolean =>
    enabledPluginSet !== null &&
    skill.owner?.kind === "plugin" &&
    !enabledPluginSet.has(skill.owner.id);

  // Apply the scope filter BEFORE the shortlist's top-K limit: restrict the
  // candidate catalog to in-scope skills so the nearest-skill search ranks and
  // slices only those. Filtering after the limit would let out-of-scope
  // high-rank matches consume slots and starve usable in-scope skills out of
  // the result. `null` set = pass the catalog through unchanged.
  const scopedCatalog = filterSkillsByPlatform(
    enabledPluginSet === null
      ? catalog
      : catalog.filter((skill) => !outOfScope(skill)),
  );

  throwIfCancelled(context);

  const hits = await findNearest(goal, {
    limit,
    loadCatalog: () => scopedCatalog,
    // The shortlist is a paid embedding round-trip with its own retries, so a
    // stopped turn stops paying rather than finishing a search nobody reads.
    ...(context.signal ? { signal: context.signal } : {}),
  });

  const fromRetrospective =
    context.requestOrigin === MEMORY_RETROSPECTIVE_ORIGIN;

  const enriched: EnrichedHit[] = [];
  for (const hit of hits) {
    const skill = byId.get(hit.skillId);
    if (!skill) {
      continue;
    }
    // Defense in depth: the scoped catalog already excludes out-of-scope plugin
    // skills, but re-check so a shortlist source that ignores the catalog seam
    // still cannot leak one.
    if (outOfScope(skill)) {
      continue;
    }
    // Join install-meta authorship for managed hits so the caller can tell its
    // OWN skills (overwritable) from a user's. Best-effort: an absent/failed
    // meta read leaves `author` undefined rather than throwing.
    const author =
      skill.source === "managed"
        ? readManagedSkillAuthor(hit.skillId)
        : undefined;
    // Only a refinable hit pays for the disk read, and a failed read drops
    // `current` rather than the hit: the pass can still skip a skill it
    // cannot see, it just cannot rewrite it well. Absent fields serialize
    // away with the result.
    const stored =
      fromRetrospective && author === "assistant"
        ? readStored(hit.skillId)
        : null;
    enriched.push({
      skill_id: hit.skillId,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      author,
      score: hit.score,
      current: stored
        ? {
            name: stored.name,
            description: stored.description,
            emoji: stored.emoji,
            category: stored.category,
            includes: stored.includes,
            activation_hints: stored.activationHints,
            avoid_when: stored.avoidWhen,
            body_markdown: stored.body,
          }
        : undefined,
    });
  }

  return {
    content: JSON.stringify({ skills: enriched }),
    isError: false,
  };
}

/**
 * Read a managed skill's install-meta author, if any. Best-effort: any failure
 * (missing dir, malformed meta, untagged skill) resolves to undefined so the
 * enrichment loop never throws on a single bad hit.
 */
function readManagedSkillAuthor(
  skillId: string,
): "assistant" | "user" | undefined {
  try {
    return readInstallMeta(getManagedSkillDir(skillId))?.author;
  } catch {
    return undefined;
  }
}
