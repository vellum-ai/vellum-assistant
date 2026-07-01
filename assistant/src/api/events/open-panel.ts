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
});

export type OpenPanelEvent = z.infer<typeof OpenPanelEventSchema>;
