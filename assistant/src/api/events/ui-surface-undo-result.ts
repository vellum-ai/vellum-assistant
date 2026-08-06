/**
 * `ui_surface_undo_result` SSE event.
 *
 * Server → client result of an undo applied to a surface's submitted
 * action (requested over the `surfaces/:id/undo` HTTP route). Reports
 * whether the undo succeeded and how many undo entries remain, keyed by
 * `surfaceId`.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const UISurfaceUndoResultEventSchema = z.object({
  type: z.literal("ui_surface_undo_result"),
  conversationId: z.string(),
  surfaceId: z.string(),
  success: z.boolean(),
  /** Number of remaining undo entries after this undo. */
  remainingUndos: z.number(),
});

export type UISurfaceUndoResultEvent = z.infer<
  typeof UISurfaceUndoResultEventSchema
>;
