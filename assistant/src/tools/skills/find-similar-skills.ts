import { v7 as uuidv7 } from "uuid";

import type { SkillSource } from "../../config/skills.js";
import { loadSkillCatalog } from "../../config/skills.js";
import { resolveRetrospectiveSkillMonitoringContext } from "../../plugins/defaults/memory/memory-retrospective-skill-monitoring.js";
import {
  type MemoryRetrospectiveSkillCandidateInput,
  recordMemoryRetrospectiveSkillSearch,
} from "../../plugins/defaults/memory/memory-retrospective-skill-monitoring-store.js";
import {
  evaluateNearestExistingSkills,
  nearestExistingSkills,
  type SkillMatchEvaluation,
} from "../../plugins/defaults/memory/v3/candidate-match.js";
import { readInstallMeta } from "../../skills/install-meta.js";
import { getManagedSkillDir } from "../../skills/managed-store.js";
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
 */
interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  owner?: OwnerInfo;
  platforms?: SkillPlatform[];
}

interface EnrichedHit {
  skill_id: string;
  name: string;
  description: string;
  source: SkillSource;
  author?: "assistant" | "user";
  score: number;
}

/**
 * Core execution logic for find_similar_skills. Read-only: scores `goal`
 * against the skill catalog's capability pages and returns the nearest skills,
 * each joined to its catalog name/description. Exported so bundled-skill
 * executors and tests can call it directly.
 *
 * `deps` injects the shortlist + catalog seams so tests run without Qdrant.
 */
export async function executeFindSimilarSkills(
  input: Record<string, unknown>,
  context: ToolContext,
  deps: {
    nearestExistingSkills?: typeof nearestExistingSkills;
    loadCatalog?: () => CatalogSkill[];
    evaluateNearestExistingSkills?: typeof evaluateNearestExistingSkills;
    resolveMonitoringContext?: typeof resolveRetrospectiveSkillMonitoringContext;
    recordMonitoringSearch?: typeof recordMemoryRetrospectiveSkillSearch;
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
  const pluginScopedCatalog =
    enabledPluginSet === null
      ? catalog
      : catalog.filter((skill) => !outOfScope(skill));
  const scopedCatalog = filterSkillsByPlatform(pluginScopedCatalog);

  throwIfCancelled(context);

  let monitoringContext: ReturnType<
    typeof resolveRetrospectiveSkillMonitoringContext
  > = null;
  try {
    const resolveMonitoringContext =
      deps.resolveMonitoringContext ??
      resolveRetrospectiveSkillMonitoringContext;
    monitoringContext = resolveMonitoringContext(context);
  } catch {
    // Monitoring setup is fail-soft. The shortlist still runs normally.
  }

  const scoreOptions = {
    limit,
    loadCatalog: () => scopedCatalog,
    // The shortlist is a paid embedding round-trip with its own retries, so a
    // stopped turn stops paying rather than finishing a search nobody reads.
    ...(context.signal ? { signal: context.signal } : {}),
  };
  const evaluation: SkillMatchEvaluation = monitoringContext
    ? deps.evaluateNearestExistingSkills
      ? await deps.evaluateNearestExistingSkills(goal, scoreOptions)
      : deps.nearestExistingSkills
        ? {
            hits: await findNearest(goal, scoreOptions),
            discarded: [],
            scorerFailed: false,
          }
        : await evaluateNearestExistingSkills(goal, scoreOptions)
    : {
        hits: await findNearest(goal, scoreOptions),
        discarded: [],
        scorerFailed: false,
      };
  const hits = evaluation.hits;

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
    enriched.push({
      skill_id: hit.skillId,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      // Join install-meta authorship for managed hits so the caller can tell its
      // OWN skills (overwritable) from a user's. Best-effort: an absent/failed
      // meta read leaves `author` undefined rather than throwing.
      author:
        skill.source === "managed"
          ? readManagedSkillAuthor(hit.skillId)
          : undefined,
      score: hit.score,
    });
  }

  let monitoringSearchId: string | undefined;
  if (monitoringContext) {
    try {
      const searchId = context.toolUseId ?? uuidv7();
      const recordMonitoringSearch =
        deps.recordMonitoringSearch ?? recordMemoryRetrospectiveSkillSearch;
      if (
        recordMonitoringSearch({
          id: searchId,
          conversationId: monitoringContext.conversationId,
          runConversationId: monitoringContext.runConversationId,
          goal: goal.trim(),
          candidates: buildMonitoringCandidates({
            catalog,
            pluginScopedCatalog,
            scopedCatalog,
            evaluation,
            enriched,
          }),
        })
      ) {
        monitoringSearchId = searchId;
      }
    } catch {
      // Monitoring persistence is fail-soft. The search result remains usable.
    }
  }

  return {
    content: JSON.stringify({
      skills: enriched,
      ...(monitoringSearchId
        ? { monitoring_search_id: monitoringSearchId }
        : {}),
    }),
    isError: false,
  };
}

function buildMonitoringCandidates(args: {
  catalog: CatalogSkill[];
  pluginScopedCatalog: CatalogSkill[];
  scopedCatalog: CatalogSkill[];
  evaluation: SkillMatchEvaluation;
  enriched: EnrichedHit[];
}): MemoryRetrospectiveSkillCandidateInput[] {
  const pluginScopedIds = new Set(
    args.pluginScopedCatalog.map((skill) => skill.id),
  );
  const scopedIds = new Set(args.scopedCatalog.map((skill) => skill.id));
  const hitsById = new Map(
    args.evaluation.hits.map((hit, rank) => [
      hit.skillId,
      { score: hit.score, rank: rank + 1 },
    ]),
  );
  const discardsById = new Map(
    args.evaluation.discarded.map((discard) => [discard.skillId, discard]),
  );
  const authorsById = new Map(
    args.enriched.map((skill) => [skill.skill_id, skill.author]),
  );

  return args.catalog.map((skill) => {
    const skillAuthor =
      skill.source === "managed"
        ? (authorsById.get(skill.id) ?? readManagedSkillAuthor(skill.id))
        : undefined;
    const base = {
      skillId: skill.id,
      skillName: skill.name,
      skillDescription: skill.description,
      skillSource: skill.source,
      ...(skillAuthor ? { skillAuthor } : {}),
    };
    if (!pluginScopedIds.has(skill.id)) {
      return {
        ...base,
        considerationStatus: "excluded" as const,
        systemExclusionReason: "out_of_plugin_scope" as const,
      };
    }
    if (!scopedIds.has(skill.id)) {
      return {
        ...base,
        considerationStatus: "excluded" as const,
        systemExclusionReason: "incompatible_platform" as const,
      };
    }
    const hit = hitsById.get(skill.id);
    if (hit) {
      return {
        ...base,
        considerationStatus: "surfaced" as const,
        rank: hit.rank,
        score: hit.score,
      };
    }
    if (args.evaluation.scorerFailed) {
      return {
        ...base,
        considerationStatus: "excluded" as const,
        systemExclusionReason: "scorer_failed" as const,
      };
    }
    const discard = discardsById.get(skill.id);
    if (discard) {
      return {
        ...base,
        considerationStatus: "excluded" as const,
        systemExclusionReason: discard.reason,
        score: discard.score,
      };
    }
    return {
      ...base,
      considerationStatus: "excluded" as const,
      systemExclusionReason: "no_score_returned" as const,
    };
  });
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
