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
 * Card and file_upload use canonical schemas; the remaining types are
 * hand-written interfaces in `daemon/message-types/surfaces.ts` pending
 * migration.
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

/**
 * Accepted MIME-type / extension patterns for a `file_upload` surface.
 *
 * The renderer consumes this as a `string[]` — it calls `.join`/`.some`/
 * `.length` on the value — but the model may emit a single comma-joined string
 * ("image/*, application/pdf") or a bare string. Coercing every shape to a
 * clean `string[]` keeps that array invariant intact: a string is split on
 * commas; array entries are stringified and trimmed; blanks and any non-array
 * value collapse to `undefined` (no restriction).
 */
const FileUploadAcceptedTypesSchema = z.preprocess((value) => {
  const items =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value
        : [];
  const cleaned = items
    .map((item) =>
      typeof item === "string" || typeof item === "number"
        ? String(item).trim()
        : "",
    )
    .filter((item) => item.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}, z.array(z.string()).optional());

export const FileUploadSurfaceDataSchema = z.object({
  prompt: z.coerce.string().optional(),
  acceptedTypes: FileUploadAcceptedTypesSchema,
  /** A non-positive or non-numeric value is dropped rather than rejecting the surface. */
  maxFiles: z.coerce.number().int().positive().optional().catch(undefined),
  maxSizeBytes: z.coerce.number().positive().optional().catch(undefined),
});
export type FileUploadSurfaceData = z.infer<typeof FileUploadSurfaceDataSchema>;
