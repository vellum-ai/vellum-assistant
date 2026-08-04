/**
 * `context_window_usage` SSE event.
 *
 * Server → client push of a conversation's current context-window usage,
 * measured with the provider's own tokenizer. Emitted by user-initiated
 * compaction (`/compact`, "summarize up to here"), which recomputes the
 * count outside any turn and so has no `usage_update` to carry it. Clients
 * apply it to the context-window indicator, which otherwise only refreshes
 * on the next LLM call.
 *
 * `tokens` and `maxTokens` are the same figures the compaction result card
 * reports, so the indicator and the card always agree.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ContextWindowUsageEventSchema = z.object({
  type: z.literal("context_window_usage"),
  conversationId: z.string(),
  /** Prompt tokens the conversation's context currently occupies. */
  tokens: z.number(),
  /** Input-token ceiling of the resolved context window. */
  maxTokens: z.number(),
});

export type ContextWindowUsageEvent = z.infer<
  typeof ContextWindowUsageEventSchema
>;
