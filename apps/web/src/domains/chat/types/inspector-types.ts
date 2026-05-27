/**
 * Type definitions for the conversation LLM context inspector. These
 * mirror what the daemon's `GET /v1/messages/:id/llm-context` route
 * returns (see `assistant/src/runtime/routes/conversation-query-routes.ts`
 * + `assistant/src/runtime/routes/llm-context-normalization.ts`). The
 * route is reachable on web through the gateway's runtime-proxy
 * wildcard at
 * `/v1/assistants/{assistantId}/conversations/llm-context/`.
 *
 * The per-row shape (`LLMRequestLogEntry`, `LLMCallSummary`,
 * `LLMContextSection`) is the canonical wire contract and lives in the
 * `@vellumai/assistant-api` package; import those types from there.
 */

import type { LLMRequestLogEntry } from "@vellumai/assistant-api";

/**
 * A single recalled memory candidate, normalized by the daemon from the
 * SSE-event format into inspector format.
 */
export interface MemoryCandidate {
  nodeId: string;
  score: number;
  semanticSimilarity: number;
  recencyBoost: number;
  type?: string;
}

/**
 * Degradation details when memory recall ran in a degraded mode.
 */
export interface MemoryDegradation {
  reason: string;
  semanticUnavailable: boolean;
  fallbackSources: string[];
}

/**
 * Memory recall log shape. Mirrors `MemoryRecallLog` from
 * `assistant/src/memory/memory-recall-log-store.ts`.
 */
export interface MemoryRecallLog {
  enabled: boolean;
  degraded: boolean;
  provider: string | null;
  model: string | null;
  degradation: MemoryDegradation | null;
  semanticHits?: number | null;
  mergedCount?: number | null;
  selectedCount?: number | null;
  tier1Count?: number | null;
  tier2Count?: number | null;
  hybridSearchLatencyMs?: number | null;
  sparseVectorUsed?: boolean | null;
  injectedTokens?: number | null;
  latencyMs?: number | null;
  topCandidates: MemoryCandidate[];
  injectedText: string | null;
  reason: string | null;
  queryContext: string | null;
}

/**
 * One concept row in the V2 activation log. Mirrors
 * `MemoryV2ConceptRowRecord` from
 * `assistant/src/memory/memory-v2-activation-log-store.ts`.
 */
export interface MemoryV2ConceptRow {
  slug: string;
  finalActivation: number;
  ownActivation: number;
  priorActivation: number;
  simUser: number;
  simAssistant: number;
  simNow: number;
  simUserRerankBoost?: number;
  simAssistantRerankBoost?: number;
  inRerankPool?: boolean;
  spreadContribution: number;
  source: "prior_state" | "ann_top50" | "both" | string;
  status: "in_context" | "injected" | "not_injected" | "page_missing" | string;
}

/**
 * Config snapshot used when the V2 activation ran. Mirrors
 * `MemoryV2ConfigSnapshot` (note: daemon uses snake_case keys).
 */
export interface MemoryV2ConfigSnapshot {
  d: number;
  c_user: number;
  c_assistant: number;
  c_now: number;
  k: number;
  hops: number;
  top_k: number;
  epsilon: number;
}

/**
 * Memory v2 activation log shape. Mirrors the return value of
 * `getMemoryV2ActivationLogByMessageIds` in
 * `assistant/src/memory/memory-v2-activation-log-store.ts`.
 */
export interface MemoryV2ActivationLog {
  turn: number;
  mode: "context-load" | "per-turn" | string;
  concepts: MemoryV2ConceptRow[];
  config: MemoryV2ConfigSnapshot;
}

/**
 * The full payload returned by
 * `GET /v1/conversations/llm-context`. Hydrates the Overview /
 * Memory / Prompt / Response tabs from a single fetch.
 *
 * `conversationTotalEstimatedCostUsd` is the running total of priced
 * LLM costs across every call in the conversation, sourced from the
 * daemon's `conversations.total_estimated_cost` column. The field is
 * optional because older daemons predate it — treat undefined / null
 * as "unavailable".
 */
export interface LlmContextResponse {
  messageId?: string | null;
  conversationKey?: string | null;
  conversationId?: string | null;
  conversationKind: string;
  conversationTotalEstimatedCostUsd?: number | null;
  logs: LLMRequestLogEntry[];
  memoryRecall: MemoryRecallLog | null;
  memoryV2Activation: MemoryV2ActivationLog | null;
}
