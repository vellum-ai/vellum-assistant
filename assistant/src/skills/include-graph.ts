import type { SkillSummary } from "../config/skills.js";

export interface IncludeGraphResult {
  /** Ordered list of all skill IDs visited during traversal (including the root). */
  visited: string[];
}

/**
 * Build an index of skills by their exact ID for O(1) lookup.
 */
export function indexCatalogById(
  catalog: SkillSummary[],
): Map<string, SkillSummary> {
  const index = new Map<string, SkillSummary>();
  for (const skill of catalog) {
    index.set(skill.id, skill);
  }
  return index;
}

/**
 * Get the immediate child skill summaries for a given parent.
 * Returns only children that exist in the catalog.
 */
export function getImmediateChildren(
  parentId: string,
  catalogIndex: Map<string, SkillSummary>,
): SkillSummary[] {
  const parent = catalogIndex.get(parentId);
  if (!parent?.includes || parent.includes.length === 0) return [];

  const children: SkillSummary[] = [];
  for (const childId of parent.includes) {
    const child = catalogIndex.get(childId);
    if (child) children.push(child);
  }
  return children;
}

export interface IncludeValidationSuccess {
  ok: true;
  visited: string[];
}

export interface IncludeValidationError {
  ok: false;
  error: "missing";
  missingChildId: string;
  parentId: string;
  path: string[]; // full path from root to the parent that referenced the missing child
}

export interface IncludeValidationCycleError {
  ok: false;
  error: "cycle";
  cyclePath: string[]; // the IDs forming the cycle, e.g. ['a', 'b', 'c', 'a']
}

export type IncludeValidationResult =
  | IncludeValidationSuccess
  | IncludeValidationError
  | IncludeValidationCycleError;

/**
 * Validate the include graph starting from the given root skill ID.
 * Uses three-state DFS (unseen/visiting/done) to detect both missing children
 * and cycles. Returns the first error encountered in DFS order.
 */
export function validateIncludes(
  rootId: string,
  catalogIndex: Map<string, SkillSummary>,
): IncludeValidationResult {
  const visited: string[] = [];
  type State = "unseen" | "visiting" | "done";
  const state = new Map<string, State>();
  const ancestry: string[] = []; // current DFS path for cycle reporting

  function dfs(
    id: string,
  ): IncludeValidationError | IncludeValidationCycleError | null {
    const currentState = state.get(id) ?? "unseen";

    if (currentState === "done") return null;

    if (currentState === "visiting") {
      // Found a cycle — build the cycle path from the point where id first appears
      const cycleStart = ancestry.indexOf(id);
      const cyclePath = [...ancestry.slice(cycleStart), id];
      return { ok: false, error: "cycle", cyclePath };
    }

    state.set(id, "visiting");
    ancestry.push(id);
    visited.push(id);

    const skill = catalogIndex.get(id);
    if (skill?.includes) {
      for (const childId of skill.includes) {
        if (!catalogIndex.has(childId)) {
          return {
            ok: false,
            error: "missing",
            missingChildId: childId,
            parentId: id,
            path: [...ancestry],
          };
        }
        const childError = dfs(childId);
        if (childError) return childError;
      }
    }

    ancestry.pop();
    state.set(id, "done");
    return null;
  }

  const error = dfs(rootId);
  if (error) return error;
  return { ok: true, visited };
}

/**
 * Recursively traverse the include graph starting from the given root skill ID.
 * Returns all visited skill IDs in DFS pre-order.
 * Happy-path only — skips missing children silently.
 */
export function traverseIncludes(
  rootId: string,
  catalogIndex: Map<string, SkillSummary>,
): IncludeGraphResult {
  const visited: string[] = [];
  const seen = new Set<string>();

  function dfs(id: string): void {
    if (seen.has(id)) return;
    seen.add(id);
    visited.push(id);

    const skill = catalogIndex.get(id);
    if (!skill?.includes) return;

    for (const childId of skill.includes) {
      if (seen.has(childId)) continue;
      // Only traverse children that exist in the catalog
      if (!catalogIndex.has(childId)) continue;
      dfs(childId);
    }
  }

  dfs(rootId);
  return { visited };
}
