/**
 * `config_changed` SSE event.
 *
 * Server → client invalidation signal emitted when the workspace
 * `config.json` changes on disk. Carries no payload — clients refetch
 * config-derived state on receipt.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ConfigChangedEventSchema = z.object({
  type: z.literal("config_changed"),
});

export type ConfigChangedEvent = z.infer<typeof ConfigChangedEventSchema>;
