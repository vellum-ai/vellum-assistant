/**
 * Wire contract for the memory v3 selection set surfaced in the inspector's
 * Memory tab. Mirrors the return value of `getMemoryV3SelectionForInspector`
 * in `assistant/src/plugins/defaults/memory-v3-shadow/selection-log-store.ts`.
 *
 * Canonical wire-contract source. Assistant code imports the types directly
 * from this file via relative paths; external consumers (web client, gateway,
 * evals) import via `@vellumai/assistant-api`.
 *
 * Returned as part of `LlmContextResponse` — see `./llm-context-response.ts`.
 *
 * `live` / `shadow` reflect the CURRENT `memory-v3-live` / `memory-v3-shadow`
 * flag state, not the per-turn history (the selection rows don't record which
 * mode was active when they were written). When `live` is true the rendered
 * `injectedText` reflects the live selection; when only `shadow` is true it is
 * the block that WOULD have been injected.
 *
 * `injectedText` is inspector-only, not a verbatim record of the live cards +
 * spotlight. It re-renders each selection's matched section — resolved from the
 * persisted `(slug, sectionOrdinal)` against the CURRENT page — falling back to
 * the full page when no section was recorded. Because the section text is
 * re-derived from the current page, it reflects bounded page-drift if the page
 * changed since the turn (the same approximation the v2 inspector accepts). The
 * selected slug set and each row's matched-section heading are exact as logged.
 */

import { z } from "zod";

/**
 * One selected page in the v3 set. `source` is the lane that surfaced it —
 * the daemon emits `core`, `hot`, `needle`, `dense`, or `edge` (historical
 * rows may carry retired labels) — but the schema stays a permissive string
 * so a new lane label (or a historical pre-lane row) doesn't break parsing on
 * the FE. `pinned` marks a page the turn was centrally about.
 * `sectionOrdinal`/`sectionHeading` identify the matched section a finder lane
 * surfaced (null for core/hot/fresh/edge selections and pre-migration rows).
 */
export const MemoryV3SelectionRowSchema = z.object({
  slug: z.string(),
  source: z.string(),
  pinned: z.boolean(),
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
 * `(slug, sectionOrdinal)` (full-page fallback when none). See the file header.
 */
export const MemoryV3SelectionLogSchema = z.object({
  turn: z.number(),
  live: z.boolean(),
  shadow: z.boolean(),
  selections: z.array(MemoryV3SelectionRowSchema),
  injectedText: z.string(),
});

export type MemoryV3SelectionLog = z.infer<typeof MemoryV3SelectionLogSchema>;
