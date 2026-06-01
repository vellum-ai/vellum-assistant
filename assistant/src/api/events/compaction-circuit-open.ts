/**
 * `compaction_circuit_open` SSE event.
 *
 * Emitted when the per-conversation auto-compaction circuit breaker trips
 * (3 consecutive failures). The Swift / web client surfaces a banner
 * indicating auto-compaction is paused until `openUntil` (ms epoch).
 *
 * `reason` is narrowed to the only string the daemon emits today
 * (`"3_consecutive_failures"`). Strict by design — any future trip
 * reason must be added here and on the daemon side together.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const CompactionCircuitOpenEventSchema = z.object({
  type: z.literal("compaction_circuit_open"),
  conversationId: z.string(),
  reason: z.literal("3_consecutive_failures"),
  /** Timestamp (ms since epoch) when the breaker will allow auto-compaction again. */
  openUntil: z.number(),
});

export type CompactionCircuitOpenEvent = z.infer<
  typeof CompactionCircuitOpenEventSchema
>;
