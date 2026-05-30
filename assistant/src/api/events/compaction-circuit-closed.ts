/**
 * `compaction_circuit_closed` SSE event.
 *
 * Emitted when the per-conversation auto-compaction circuit breaker
 * transitions from open → closed because a successful compaction reset
 * `ctx.compactionCircuitOpenUntil`. Clients clear the "auto-compaction
 * paused" banner so it dismisses immediately instead of lingering until
 * the original `openUntil` deadline.
 *
 * Only fires on the open → closed transition — successful compactions
 * while the breaker was already closed would be noise.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const CompactionCircuitClosedEventSchema = z.object({
  type: z.literal("compaction_circuit_closed"),
  conversationId: z.string(),
});

export type CompactionCircuitClosedEvent = z.infer<
  typeof CompactionCircuitClosedEventSchema
>;
