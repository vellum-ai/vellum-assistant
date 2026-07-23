/**
 * `context_compacted` SSE event.
 *
 * Server → client notification that a conversation's context was
 * compacted, carrying before/after token counts and the summary-LLM
 * cost, plus optional quality signals about the produced summary.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ContextCompactedEventSchema = z.object({
  type: z.literal("context_compacted"),
  conversationId: z.string(),
  previousEstimatedInputTokens: z.number(),
  estimatedInputTokens: z.number(),
  maxInputTokens: z.number(),
  thresholdTokens: z.number(),
  compactedMessages: z.number(),
  summaryCalls: z.number(),
  summaryInputTokens: z.number(),
  summaryOutputTokens: z.number(),
  summaryModel: z.string(),
  /**
   * Quality signals for the generated summary. Emitted for every
   * compaction (including truncation-only paths where the summary text
   * is unchanged from the prior pass). Consumers can use these to detect
   * regressions without needing to read the summary text itself.
   */
  summaryCharCount: z.number().optional(),
  summaryHeaderCount: z.number().optional(),
  summaryHadMemoryEcho: z.boolean().optional(),
});

export type ContextCompactedEvent = z.infer<typeof ContextCompactedEventSchema>;
