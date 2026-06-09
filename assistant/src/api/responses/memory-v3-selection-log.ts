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
 * `injectedText` is APPROXIMATE, not a verbatim record. It is re-rendered from
 * the persisted selection rows, which store slug/source/pinned but NOT the
 * matched-section identity. A page that live injection sent as a single matched
 * section is re-rendered here as its FULL page (the section ordinal isn't
 * persisted), so the text can differ from what was actually sent to the model.
 * The selected slug set is exact — only the rendered text is full-page
 * approximate. Persisting the per-turn injected section is a documented
 * follow-up.
 */

import { z } from "zod";

/**
 * One selected page in the v3 set. `source` is the lane that surfaced it —
 * the daemon emits `needle`, `dense`, `edge`, or `carry-forward` — but the
 * schema stays a permissive string so a new lane label (or a historical
 * pre-lane row) doesn't break parsing on the FE. `pinned` marks a slug carried
 * forward across turns.
 */
export const MemoryV3SelectionRowSchema = z.object({
  slug: z.string(),
  source: z.string(),
  pinned: z.boolean(),
});

export type MemoryV3SelectionRow = z.infer<typeof MemoryV3SelectionRowSchema>;

/**
 * Memory v3 selection log shape. `injectedText` is the rendered
 * `<memory>…</memory>` block for the selection — APPROXIMATE: re-rendered from
 * the persisted rows, with full pages where live injection used a matched
 * section (the section identity isn't persisted). See the file header.
 */
export const MemoryV3SelectionLogSchema = z.object({
  turn: z.number(),
  live: z.boolean(),
  shadow: z.boolean(),
  selections: z.array(MemoryV3SelectionRowSchema),
  injectedText: z.string(),
});

export type MemoryV3SelectionLog = z.infer<typeof MemoryV3SelectionLogSchema>;
