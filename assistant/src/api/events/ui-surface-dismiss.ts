/**
 * `ui_surface_dismiss` SSE event.
 *
 * Server → client request to remove a previously-shown surface
 * without a completion payload. Used when the surface is cancelled,
 * superseded, or the daemon has determined the user input is no
 * longer needed. Identified by `surfaceId`.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const UISurfaceDismissEventSchema = z.object({
  type: z.literal("ui_surface_dismiss"),
  conversationId: z.string(),
  surfaceId: z.string(),
});

export type UISurfaceDismissEvent = z.infer<typeof UISurfaceDismissEventSchema>;
