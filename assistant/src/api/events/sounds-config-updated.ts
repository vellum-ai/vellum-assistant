/**
 * `sounds_config_updated` SSE event.
 *
 * Server → client invalidation signal emitted when the sounds config or
 * the sound files change on disk. Carries no payload — clients refetch
 * their sound set on receipt.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const SoundsConfigUpdatedEventSchema = z.object({
  type: z.literal("sounds_config_updated"),
});

export type SoundsConfigUpdatedEvent = z.infer<
  typeof SoundsConfigUpdatedEventSchema
>;
