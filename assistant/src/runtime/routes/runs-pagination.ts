/**
 * Shared cursor-pagination helpers for run-history routes
 * (`heartbeat/runs`, `consolidation/runs`, `schedules/:id/runs`).
 *
 * Pages are keyed by each route's epoch-millis sort column. Clients pass the
 * previous page's `nextCursor` back as `before` to fetch strictly older rows;
 * a null `nextCursor` means the history is exhausted.
 */

import { z } from "zod";

import type { RouteQueryParam } from "./types.js";

/** Parse the optional `before` cursor query param (epoch millis). */
export function parseRunsBeforeCursor(
  queryParams: Record<string, string>,
): number | undefined {
  const raw = Number(queryParams.before);
  return Number.isFinite(raw) ? raw : undefined;
}

/** Parse and clamp the `limit` query param to 1..100. */
export function parseRunsLimit(
  queryParams: Record<string, string>,
  defaultLimit: number,
): number {
  const raw = Number(queryParams.limit ?? defaultLimit);
  return Number.isFinite(raw)
    ? Math.min(Math.max(Math.floor(raw), 1), 100)
    : defaultLimit;
}

/**
 * Slice a `limit + 1`-sized fetch down to the page and derive `nextCursor`
 * from the last returned row's sort key (null when no older rows remain).
 */
export function paginateRuns<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => number,
): { rows: T[]; nextCursor: number | null } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: page,
    nextCursor: hasMore ? cursorOf(page[page.length - 1]) : null,
  };
}

/** Shared `nextCursor` response field for the paginated run-list routes. */
export const RUNS_NEXT_CURSOR_SCHEMA = z
  .number()
  .nullable()
  .describe(
    "Cursor for fetching older runs (pass as `before`); null when no " +
      "older runs exist",
  );

/** OpenAPI query-param entries shared by the paginated run-list routes. */
export const RUNS_PAGINATION_QUERY_PARAMS = (
  defaultLimit: number,
): RouteQueryParam[] => [
  {
    name: "limit",
    schema: { type: "integer" },
    description: `Max runs to return (default ${defaultLimit}, max 100)`,
  },
  {
    name: "before",
    schema: { type: "integer" },
    description:
      "Cursor for older runs: pass the previous page's `nextCursor` to " +
      "return runs strictly older than it.",
  },
];
