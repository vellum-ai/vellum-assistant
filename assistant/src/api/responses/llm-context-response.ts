/**
 * Wire contract for the full payload returned by
 * `GET /v1/conversations/llm-context`. Hydrates the Overview / Memory
 * / Prompt / Response tabs from a single fetch.
 *
 * Canonical wire-contract source. Assistant code imports the types
 * directly from this file via relative paths; external consumers
 * (web client, gateway, evals) import via `@vellumai/assistant-api`.
 *
 * The route is reachable on web through the gateway's runtime-proxy
 * wildcard at
 * `/v1/assistants/{assistantId}/conversations/llm-context/`. The
 * response is built in `assistant/src/runtime/routes/conversation-query-routes.ts`.
 *
 * `conversationTotalEstimatedCostUsd` is the running total of priced
 * LLM costs across every call in the conversation, sourced from the
 * daemon's `conversations.total_estimated_cost` column. The field is
 * optional because older daemons predate it — treat undefined / null
 * as "unavailable".
 */

import { z } from "zod";

import { LLMRequestLogEntrySchema } from "./llm-request-log-entry.js";
import { MemoryRecallLogSchema } from "./memory-recall-log.js";
import { MemoryV2ActivationLogSchema } from "./memory-v2-activation-log.js";
import { MemoryV3SelectionLogSchema } from "./memory-v3-selection-log.js";

export const LlmContextResponseSchema = z.object({
  messageId: z.string().nullish(),
  conversationKey: z.string().nullish(),
  conversationId: z.string().nullish(),
  conversationKind: z.string(),
  conversationTotalEstimatedCostUsd: z.number().nullish(),
  logs: z.array(LLMRequestLogEntrySchema),
  memoryRecall: MemoryRecallLogSchema.nullable(),
  memoryV2Activation: MemoryV2ActivationLogSchema.nullable(),
  memoryV3Selection: MemoryV3SelectionLogSchema.nullish(),
});

export type LlmContextResponse = z.infer<typeof LlmContextResponseSchema>;
