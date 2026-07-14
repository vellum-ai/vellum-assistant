import { type SkillFilter } from "./types";

/**
 * URL search-param state for the Skills list (`/assistant/skills`).
 *
 * The list reflects its search text, status filter, and category into
 * `?q=` / `?filter=` / `?category=` so the filtered view survives route
 * navigation (detail page and back, browser history, shared links).
 * Defaults are omitted so the plain `/assistant/skills` URL stays clean.
 *
 * Mirrors the usage tab's URL-state pattern
 * (`domains/settings/billing/usage/usage-tab-state.ts`).
 */

export const DEFAULT_SKILL_FILTER: SkillFilter = "all";

const SKILL_FILTERS = new Set<SkillFilter>([
  "all",
  "installed",
  "available",
  "vellum",
  "clawhub",
  "skillssh",
  "custom",
  "assistant-memory",
]);

export interface SkillsUrlState {
  /** Search text (`?q=`); empty string when absent. */
  q: string;
  /** Status/origin filter (`?filter=`); `"all"` when absent or invalid. */
  filter: SkillFilter;
  /** Category slug (`?category=`); `null` when absent. */
  category: string | null;
}

export interface SkillsSearchParamsUpdate {
  q?: string;
  filter?: SkillFilter;
  /** `null` clears the category (the "All" row). */
  category?: string | null;
}

export function readSkillsUrlState(
  searchParams: URLSearchParams,
): SkillsUrlState {
  const rawFilter = searchParams.get("filter");
  const category = searchParams.get("category");
  return {
    q: searchParams.get("q") ?? "",
    filter: isSkillFilter(rawFilter) ? rawFilter : DEFAULT_SKILL_FILTER,
    category: category || null,
  };
}

/**
 * Build the next search params from `searchParams` with `update` applied.
 * Default values (empty search, `"all"` filter, no category) are removed
 * rather than serialized; unrelated params are preserved.
 */
export function buildSkillsSearchParams(
  searchParams: URLSearchParams,
  update: SkillsSearchParamsUpdate,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  if (update.q !== undefined) {
    setOrDelete(next, "q", update.q.trim() || null);
  }
  if (update.filter !== undefined) {
    setOrDelete(
      next,
      "filter",
      update.filter === DEFAULT_SKILL_FILTER ? null : update.filter,
    );
  }
  if (update.category !== undefined) {
    setOrDelete(next, "category", update.category);
  }
  return next;
}

function setOrDelete(
  params: URLSearchParams,
  key: string,
  value: string | null,
): void {
  if (value === null) {
    params.delete(key);
  } else {
    params.set(key, value);
  }
}

function isSkillFilter(value: string | null): value is SkillFilter {
  return value !== null && SKILL_FILTERS.has(value as SkillFilter);
}
