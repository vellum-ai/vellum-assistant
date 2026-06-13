/**
 * `usage_update` SSE event.
 *
 * Emitted after each LLM call with per-call token counts plus the
 * conversation's running totals and estimated cost. Clients use it for
 * live-updating usage metrics and the context-window indicator. A
 * UI-only hint — it does not persist to the DB or affect billing.
 *
 * The per-call and total token counts, `estimatedCost`, and `model`
 * are always supplied by the daemon, so they are required. The
 * context-window fields are present only when the turn has a known
 * context window.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const UsageUpdateEventSchema = z.object({
  type: z.literal("usage_update"),
  conversationId: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  /**
   * Per-call prompt-cache token counts, as reported by the provider.
   * Optional: older daemons omit them, and providers without prompt
   * caching never supply them. `inputTokens` already includes these.
   */
  cacheCreationInputTokens: z.number().optional(),
  cacheReadInputTokens: z.number().optional(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  estimatedCost: z.number(),
  model: z.string(),
  contextWindowTokens: z.number().optional(),
  contextWindowMaxTokens: z.number().optional(),
});

export type UsageUpdateEvent = z.infer<typeof UsageUpdateEventSchema>;
