import type { SkillSummary } from '../config/skills.js';

export interface IncludeGraphResult {
  /** Ordered list of all skill IDs visited during traversal (including the root). */
  visited: string[];
}

/**
 * Build an index of skills by their exact ID for O(1) lookup.
 */
export function indexCatalogById(catalog: SkillSummary[]): Map<string, SkillSummary> {
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

/**
 * Recursively traverse the include graph starting from the given root skill ID.
 * Returns all visited skill IDs in DFS pre-order.
 * Happy-path only — skips missing children silently.
 */
export interface IncludeValidationSuccess {
  ok: true;
  visited: string[];
}

export interface IncludeValidationError {
  ok: false;
  error: 'missing';
  missingChildId: string;
  parentId: string;
  path: string[];  // full path from root to the parent that referenced the missing child
}

export type IncludeValidationResult = IncludeValidationSuccess | IncludeValidationError;

/**
 * Validate the include graph starting from the given root skill ID.
 * Returns an error result on the first missing child encountered (DFS order),
 * including the full path from root to the parent that referenced it.
 */
export function validateIncludes(
  rootId: string,
  catalogIndex: Map<string, SkillSummary>,
): IncludeValidationResult {
  const visited: string[] = [];
  const seen = new Set<string>();

  function dfs(id: string, path: string[]): IncludeValidationError | null {
    if (seen.has(id)) return null;
    seen.add(id);
    visited.push(id);

    const skill = catalogIndex.get(id);
    if (!skill?.includes) return null;

    const currentPath = [...path, id];
    for (const childId of skill.includes) {
      if (!catalogIndex.has(childId)) {
        return {
          ok: false,
          error: 'missing',
          missingChildId: childId,
          parentId: id,
          path: currentPath,
        };
      }
      const childError = dfs(childId, currentPath);
      if (childError) return childError;
    }
    return null;
  }

  const error = dfs(rootId, []);
  if (error) return error;
  return { ok: true, visited };
}

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
