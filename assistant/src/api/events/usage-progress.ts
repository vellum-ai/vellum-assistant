/**
 * `usage_progress` SSE event.
 *
 * Emitted after each LLM call with per-call token deltas and estimated
 * cost. Clients accumulate these additively for live-updating usage
 * metrics (e.g. inline subagent token counters). A UI-only hint — it
 * does not persist to the DB or affect billing.
 *
 * Unlike `usage_update`, which carries the conversation's running
 * totals, this event carries only the deltas for a single LLM call.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const UsageProgressEventSchema = z.object({
  type: z.literal("usage_progress"),
  conversationId: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  estimatedCost: z.number(),
  model: z.string(),
});

export type UsageProgressEvent = z.infer<typeof UsageProgressEventSchema>;
