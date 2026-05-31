/**
 * `ui_surface_complete` SSE event.
 *
 * Server → client signal that a surface's lifecycle has ended with a
 * resolution — distinct from `ui_surface_dismiss`, which is used
 * when the surface is cancelled with no result. Carries a
 * human-readable `summary` and an optional structured
 * `submittedData` payload (e.g. the form values the user submitted).
 *
 * `submittedData` is opaque on the wire — its shape depends on the
 * original `surfaceType` and lives in the surface-data subsystem.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const UISurfaceCompleteEventSchema = z.object({
  type: z.literal("ui_surface_complete"),
  conversationId: z.string(),
  surfaceId: z.string(),
  summary: z.string(),
  submittedData: z.record(z.string(), z.unknown()).optional(),
});

export type UISurfaceCompleteEvent = z.infer<
  typeof UISurfaceCompleteEventSchema
>;
