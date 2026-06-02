/**
 * `app_preview_update` SSE event.
 *
 * Live-build status broadcast for a multifile app's preview, emitted on every
 * source-file recompile so clients (web) can hot-swap the preview iframe while
 * the assistant is still writing, while keeping the last-good preview on a
 * transient compile error.
 *
 * - `building`: a recompile started; `html` is the current (last-good)
 *   resolved html so the client can show a building overlay without blanking.
 * - `ok`: recompile succeeded; `html` is the fresh resolved html and
 *   `reloadGeneration` is bumped so the client swaps the iframe.
 * - `error`: recompile failed; `html` is the previous good html, `buildErrors`
 *   carries the compile diagnostics, and `reloadGeneration` is unchanged so the
 *   iframe is NOT swapped.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const AppPreviewUpdateEventSchema = z.object({
  type: z.literal("app_preview_update"),
  appId: z.string(),
  html: z.string(),
  compileStatus: z.enum(["building", "ok", "error"]),
  buildErrors: z.array(z.string()).optional(),
  reloadGeneration: z.number(),
});

export type AppPreviewUpdateEvent = z.infer<typeof AppPreviewUpdateEventSchema>;
