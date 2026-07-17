import type { SuperpowerFilter } from "./types";

/**
 * URL search-param state for the My Superpowers list (`/assistant/superpowers`).
 *
 * The list reflects its search text, filter, and category into
 * `?q=` / `?filter=` / `?category=` so the filtered view survives route
 * navigation (detail page and back, browser history, shared links).
 * Defaults are omitted so the plain `/assistant/superpowers` URL stays clean.
 *
 * The param names are shared with the legacy `/assistant/skills` URLs, so
 * redirected bookmarks keep their filtered view.
 *
 * Mirrors the usage tab's URL-state pattern
 * (`domains/settings/billing/usage/usage-tab-state.ts`).
 */

export const DEFAULT_SUPERPOWER_FILTER: SuperpowerFilter = "all";

const SUPERPOWER_FILTERS = new Set<SuperpowerFilter>([
  "all",
  "installed",
  "available",
  "skills",
  "plugins",
  "vellum",
  "clawhub",
  "skillssh",
  "custom",
  "assistant-memory",
]);

export interface SuperpowersUrlState {
  /** Search text (`?q=`); empty string when absent. */
  q: string;
  /** Status/type/origin filter (`?filter=`); `"all"` when absent or invalid. */
  filter: SuperpowerFilter;
  /** Category slug (`?category=`); `null` when absent. */
  category: string | null;
}

export interface SuperpowersSearchParamsUpdate {
  q?: string;
  filter?: SuperpowerFilter;
  /** `null` clears the category (the "All" row). */
  category?: string | null;
}

export function readSuperpowersUrlState(
  searchParams: URLSearchParams,
): SuperpowersUrlState {
  const rawFilter = searchParams.get("filter");
  const category = searchParams.get("category");
  return {
    q: searchParams.get("q") ?? "",
    filter: isSuperpowerFilter(rawFilter) ? rawFilter : DEFAULT_SUPERPOWER_FILTER,
    category: category || null,
  };
}

/**
 * Build the next search params from `searchParams` with `update` applied.
 * Default values (empty search, `"all"` filter, no category) are removed
 * rather than serialized; unrelated params are preserved.
 */
export function buildSuperpowersSearchParams(
  searchParams: URLSearchParams,
  update: SuperpowersSearchParamsUpdate,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  if (update.q !== undefined) {
    setOrDelete(next, "q", update.q.trim() || null);
  }
  if (update.filter !== undefined) {
    setOrDelete(
      next,
      "filter",
      update.filter === DEFAULT_SUPERPOWER_FILTER ? null : update.filter,
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

function isSuperpowerFilter(value: string | null): value is SuperpowerFilter {
  return value !== null && SUPERPOWER_FILTERS.has(value as SuperpowerFilter);
}
