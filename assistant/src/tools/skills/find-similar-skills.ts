import type { SkillSource } from "../../config/skills.js";
import { loadSkillCatalog } from "../../config/skills.js";
import { nearestExistingSkills } from "../../plugins/defaults/memory-v3-shadow/candidate-match.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * A shortlisted skill enriched with its catalog name, description, and source.
 * `source` lets the caller see whether an existing skill of ANY origin already
 * covers the goal — a bundled/plugin/workspace match (or a person-authored
 * managed one) is not the retrospective's to overwrite or duplicate.
 */
interface EnrichedHit {
  skill_id: string;
  name: string;
  description: string;
  source: SkillSource;
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
  _context: ToolContext,
  deps: {
    nearestExistingSkills?: typeof nearestExistingSkills;
    loadCatalog?: () => {
      id: string;
      name: string;
      description: string;
      source: SkillSource;
    }[];
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

  const hits = await findNearest(goal, { limit });

  const catalog = loadCatalog();
  const byId = new Map(catalog.map((s) => [s.id, s]));

  const enriched: EnrichedHit[] = [];
  for (const hit of hits) {
    const skill = byId.get(hit.skillId);
    if (!skill) continue;
    enriched.push({
      skill_id: hit.skillId,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      score: hit.score,
    });
  }

  return {
    content: JSON.stringify({ skills: enriched }),
    isError: false,
  };
}
