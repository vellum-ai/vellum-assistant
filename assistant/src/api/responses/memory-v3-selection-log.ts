/**
 * Wire contract for the memory v3 selection set surfaced in the inspector's
 * Memory tab. Mirrors the return value of `getMemoryV3SelectionForInspector`
 * in `assistant/src/plugins/defaults/memory/v3/selection-log-store.ts`.
 *
 * Canonical wire-contract source. Assistant code imports the types directly
 * from this file via relative paths; external consumers (web client, gateway,
 * evals) import via `@vellumai/assistant-api`.
 *
 * Returned as part of `LlmContextResponse` — see `./llm-context-response.ts`.
 *
 * `live` reflects the CURRENT `memory.v3.live` config state, not the per-turn
 * history (the selection rows don't record whether v3 was live when they were
 * written). The rendered `injectedText` is the `<memory>` block for the logged
 * selection.
 *
 * `injectedText` is inspector-only, not a verbatim record of the live cards +
 * spotlight. It re-renders each selection's matched section — resolved from the
 * persisted `(slug, sectionOrdinal)` against the CURRENT page — falling back to
 * the full page when no section was recorded. Because the section text is
 * re-derived from the current page, it reflects bounded page-drift if the page
 * changed since the turn (the same approximation the v2 inspector accepts). The
 * selected slug set and each row's matched-section heading are exact as logged.
 *
 * `pool` is the selector's full candidate pool for the turn as persisted in
 * `memory_v3_pools`: every stable-prefix card and finder line in pool order,
 * each with its lane, matched-section heading, and verdict. `null` for turns
 * that predate pool logging.
 */

import { z } from "zod";

/**
 * One candidate the selector saw. `lane` is `core`, `hot`, `fresh`, or
 * `always` for the stable-prefix cards and a finder lane label for the tail
 * (kept a permissive string, like `source` below). `sectionHeading` is the
 * matched section a finder lane surfaced (`""` for the page lead); null for
 * cards and finder lines with no matched section. `chosen` is whether the
 * selector kept the candidate's page.
 */
export const MemoryV3PoolCandidateSchema = z.object({
  slug: z.string(),
  lane: z.string(),
  sectionHeading: z.string().nullable(),
  chosen: z.boolean(),
});

export type MemoryV3PoolCandidate = z.infer<typeof MemoryV3PoolCandidateSchema>;

/**
 * The selector's candidate pool for one turn. `poolSize` is the number of
 * candidates shown; `selectedCount` the distinct pages kept (a page can appear
 * twice when a finder lane also hit a stable-prefix card).
 */
export const MemoryV3PoolSchema = z.object({
  poolSize: z.number(),
  selectedCount: z.number(),
  candidates: z.array(MemoryV3PoolCandidateSchema),
});

export type MemoryV3Pool = z.infer<typeof MemoryV3PoolSchema>;

/**
 * One selected page in the v3 set. `source` is the lane that surfaced it —
 * the daemon emits `core`, `hot`, `needle`, `dense`, or `edge` (historical
 * rows may carry retired labels) — but the schema stays a permissive string
 * so a new lane label (or a historical pre-lane row) doesn't break parsing on
 * the FE. `sectionOrdinal`/`sectionHeading` identify the matched section a
 * finder lane surfaced (null for core/hot/fresh/edge selections and
 * pre-migration rows).
 */
export const MemoryV3SelectionRowSchema = z.object({
  slug: z.string(),
  source: z.string(),
  // The matched section a finder lane surfaced for this selection. Null for
  // core/hot/fresh/edge selections with no matched section, and for rows
  // written before the section columns existed. Optional + nullable so older
  // clients and pre-migration rows round-trip.
  sectionOrdinal: z.number().nullable().optional(),
  sectionHeading: z.string().nullable().optional(),
});

export type MemoryV3SelectionRow = z.infer<typeof MemoryV3SelectionRowSchema>;

/**
 * Memory v3 selection log shape. `injectedText` is the rendered
 * `<memory>…</memory>` block for the selection — re-rendered from the persisted
 * rows, with each selection's matched section resolved from its
 * `(slug, sectionOrdinal)` (full-page fallback when none). `pool` is the
 * turn's candidate pool, null for turns logged before pools were persisted;
 * optional so a client ahead of its assistant still parses. See the file header.
 */
export const MemoryV3SelectionLogSchema = z.object({
  turn: z.number(),
  live: z.boolean(),
  selections: z.array(MemoryV3SelectionRowSchema),
  injectedText: z.string(),
  pool: MemoryV3PoolSchema.nullable().optional(),
});

export type MemoryV3SelectionLog = z.infer<typeof MemoryV3SelectionLogSchema>;
