/**
 * `acp_session_usage` SSE event.
 *
 * Server → client gauge of an ACP session's context-window usage,
 * forwarded from the ACP `usage_update` notification. `usedTokens` is
 * the tokens currently in context, `contextSize` the window size; the
 * optional `inputTokens`/`outputTokens` are the session's cumulative
 * input/output token totals and `costAmount`/`costCurrency` mirror the
 * agent's cumulative cost. `model` and `cacheReadTokens`/`cacheWriteTokens`
 * carry the reported model and cache-token totals when the adapter provides
 * them. A side gauge, not part of the ordered update timeline — carries no
 * `seq`.
 *
 * Canonical wire-contract source. Re-exported to external consumers via
 * `@vellumai/assistant-api` (the `api/index.ts` barrel).
 */

import { z } from "zod";

export const AcpSessionUsageEventSchema = z
  .object({
    type: z.literal("acp_session_usage"),
    acpSessionId: z.string(),
    usedTokens: z.number(),
    contextSize: z.number(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    costAmount: z.number().optional(),
    costCurrency: z.string().optional(),
    model: z.string().optional(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
  })
  .strict();

export type AcpSessionUsageEvent = z.infer<typeof AcpSessionUsageEventSchema>;
