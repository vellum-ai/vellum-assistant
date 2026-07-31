/**
 * `open_panel` SSE event.
 *
 * Side-effect-only command: tells the client to open a panel or drawer
 * without rendering anything in the chat transcript. Analogous to
 * `open_url` and `navigate_settings` — the rolling-snapshot reducer
 * has no case for it, so it naturally falls through to "no change."
 *
 * `panelType` identifies which panel to open; `data` carries
 * panel-specific payload (validated by the handler, not the schema).
 *
 * `surfaceId` is the acknowledgment correlation id: the daemon holds the
 * emitting tool call open until the client confirms the panel rendered by
 * POSTing a surface action (`actionId: "ack"` / `"nack"`) with this id.
 * Clients that receive an event without a `surfaceId` have nothing to
 * acknowledge.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const OpenPanelEventSchema = z.object({
  type: z.literal("open_panel"),
  panelType: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
  conversationId: z.string().optional(),
  surfaceId: z.string().optional(),
});

export type OpenPanelEvent = z.infer<typeof OpenPanelEventSchema>;
