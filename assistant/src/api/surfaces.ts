/**
 * Canonical surface-data wire payloads.
 *
 * The `ui_surface_*` events and the conversation-message response all carry a
 * surface `data` object whose shape depends on `surfaceType`. The wire keeps
 * `data` opaque (`z.record`) — see `events/ui-surface-show.ts` for why — so
 * consumers narrow it by parsing with the canonical per-type schema here. The
 * schemas are deliberately tolerant (every field optional, Zod strip mode): a
 * parse miss makes a renderable surface silently vanish, so they must never
 * reject a real payload. The schema also defines what the daemon's `ui_show`
 * normalizer *supports* — anything the model sends outside these fields is
 * dropped (and logged) there, which is how we learn the shapes to recover.
 *
 * Card is the first surface type migrated to a canonical schema; the remaining
 * types still live as hand-written interfaces in
 * `daemon/message-types/surfaces.ts` pending migration.
 */

import { z } from "zod";

export const CardSurfaceDataSchema = z.object({
  title: z.string().optional(),
  subtitle: z.string().optional(),
  body: z.string().optional(),
  metadata: z
    .array(z.object({ label: z.coerce.string(), value: z.coerce.string() }))
    .optional(),
  /** Optional template name for specialized rendering (e.g. "weather_forecast"). */
  template: z.string().optional(),
  /** Arbitrary data consumed by the template renderer. Shape depends on template. */
  templateData: z.record(z.string(), z.unknown()).optional(),
});
export type CardSurfaceData = z.infer<typeof CardSurfaceDataSchema>;
