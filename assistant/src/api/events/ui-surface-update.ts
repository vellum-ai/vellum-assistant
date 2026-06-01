/**
 * `ui_surface_update` SSE event.
 *
 * Server → client incremental update to a previously-shown surface.
 * Identified by the `surfaceId` returned in the original
 * `ui_surface_show`. The client merges `data` into the rendered
 * surface's state. `data` is opaque at the wire level for the same
 * reason as `ui_surface_show.data` — the concrete shape depends on
 * the surface's original `surfaceType` and lives in the
 * surface-data subsystem.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const UISurfaceUpdateEventSchema = z.object({
  type: z.literal("ui_surface_update"),
  conversationId: z.string(),
  surfaceId: z.string(),
  data: z.record(z.string(), z.unknown()),
});

export type UISurfaceUpdateEvent = z.infer<typeof UISurfaceUpdateEventSchema>;
