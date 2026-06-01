/**
 * `navigate_settings` SSE event.
 *
 * Emitted by the settings navigation tool so the client opens its
 * settings UI to the named tab. The daemon validates `tab` against the
 * known settings tabs before emitting; the client maps it to a route.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const NavigateSettingsEventSchema = z.object({
  type: z.literal("navigate_settings"),
  tab: z.string(),
});

export type NavigateSettingsEvent = z.infer<typeof NavigateSettingsEventSchema>;
