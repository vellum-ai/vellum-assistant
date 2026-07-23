/**
 * `show_platform_login` SSE event.
 *
 * Emitted by the platform-connect route when no platform credentials are
 * stored yet, signalling connected clients to surface the platform login UI.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ShowPlatformLoginEventSchema = z.object({
  type: z.literal("show_platform_login"),
});

export type ShowPlatformLoginEvent = z.infer<
  typeof ShowPlatformLoginEventSchema
>;
