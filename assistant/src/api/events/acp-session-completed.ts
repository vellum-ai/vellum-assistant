/**
 * `acp_session_completed` SSE event.
 *
 * Server → client notification that an ACP session has finished its
 * turn. `stopReason` mirrors the ACP `StopReason` set.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const AcpStopReasonSchema = z.enum([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);

export type AcpStopReason = z.infer<typeof AcpStopReasonSchema>;

export const AcpSessionCompletedEventSchema = z
  .object({
    type: z.literal("acp_session_completed"),
    acpSessionId: z.string(),
    stopReason: AcpStopReasonSchema,
  })
  .strict();

export type AcpSessionCompletedEvent = z.infer<
  typeof AcpSessionCompletedEventSchema
>;
