/**
 * `ui_surface_show` SSE event.
 *
 * Server → client request to render an ephemeral UI surface (card,
 * form, list, table, confirmation, dynamic_page, file_upload,
 * document_preview, task_preferences) inside the chat view. The
 * concrete `data` shape depends on `surfaceType` and is owned by the
 * surface-data subsystem in `daemon/message-types/surfaces.ts`; the
 * canonical schema treats `data` as opaque on the wire so this file
 * doesn't have to mirror eight nested-payload schemas.
 *
 * Lifecycle: a surface progresses `show` → (zero or more `update`s) →
 * (`dismiss` for cancellation OR `complete` with a `summary` /
 * `submittedData` payload). `surfaceId` is the shared correlation key
 * across all four lifecycle events.
 *
 * `actions` is the array of clickable choices rendered alongside the
 * surface. Each action's `style` is a strict 3-variant enum because
 * the daemon-side `SurfaceAction.style` is the same enum — the wire
 * contract is stricter than the legacy parser, which accepted any
 * string.
 *
 * `persistent` defaults to false. When true, clicking an action does
 * not dismiss the surface — the client keeps it visible and only
 * marks the clicked action as spent (used for launcher / menu
 * cards). The legacy web `UISurfaceShowEvent` interface was missing
 * this field entirely — adding it via the canonical schema fixes a
 * silent wire-shape drift.
 *
 * `toolCallId` is the id of the tool call that produced the surface
 * (the `ui_show` proxy tool). The client uses it to gate display-only
 * app previews on whether that tool call's result has arrived, rather
 * than on whole-turn streaming state. Optional: surfaces emitted
 * outside a tool call (or by older daemons) omit it, and the client
 * treats a missing link as already complete.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const SurfaceActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  style: z.enum(["primary", "secondary", "destructive"]).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export type SurfaceAction = z.infer<typeof SurfaceActionSchema>;

export const UISurfaceShowEventSchema = z.object({
  type: z.literal("ui_surface_show"),
  conversationId: z.string(),
  surfaceId: z.string(),
  surfaceType: z.string(),
  title: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
  actions: z.array(SurfaceActionSchema).optional(),
  display: z.enum(["inline", "panel"]).optional(),
  messageId: z.string().optional(),
  persistent: z.boolean().optional(),
  toolCallId: z.string().optional(),
});

export type UISurfaceShowEvent = z.infer<typeof UISurfaceShowEventSchema>;
