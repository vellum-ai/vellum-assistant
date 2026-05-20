/**
 * Type definitions for the conversation LLM context inspector. Web port
 * of macOS's `LLMContextResponse` / `LLMRequestLogEntry` /
 * `LLMCallSummary` / `LLMContextSection` shapes from
 * `clients/macos/vellum-assistant/Features/Chat/MessageInspector*.swift`.
 *
 * These mirror what the daemon's `GET /v1/messages/:id/llm-context`
 * route returns (see `assistant/src/runtime/routes/conversation-query-routes.ts`
 * + `assistant/src/runtime/routes/llm-context-normalization.ts`). The
 * route is reachable on web through the platform's
 * `RuntimeProxyWildcardView` at
 * `/v1/assistants/{assistantId}/messages/{messageId}/llm-context/`.
 */

/**
 * Provider-normalized summary the daemon attaches to each request log.
 * `null` / missing fields are common and the formatters fall back to a
 * shared "Unavailable" placeholder.
 */
export interface LLMCallSummary {
  provider?: string | null;
  model?: string | null;
  status?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  stopReason?: string | null;
  requestMessageCount?: number | null;
  requestToolCount?: number | null;
  responseMessageCount?: number | null;
  responseToolCallCount?: number | null;
  responsePreview?: string | null;
  toolCallNames?: string[] | null;
  estimatedCostUsd?: number | null;
  /**
   * Wall-clock duration in milliseconds. Not in the macOS reference
   * shape today but the daemon already populates it for some providers
   * — surfaced when present so web debugging gets the extra signal.
   */
  durationMs?: number | null;
}

/**
 * A single normalized request- or response-side section. The daemon
 * splits a provider payload into kind-tagged blocks before returning;
 * each block becomes one card in the Prompt / Response tabs.
 */
export interface LLMContextSection {
  kind: string;
  label?: string | null;
  role?: string | null;
  text?: string | null;
  toolName?: string | null;
  data?: unknown;
  language?: string | null;
}

/**
 * One LLM request log row. `requestPayload` / `responsePayload` are
 * always `null` on the list endpoint — the raw JSON is fetched
 * lazily through `/v1/llm-request-logs/{logId}/payload` (added in a
 * follow-up PR).
 */
export interface LLMRequestLogEntry {
  id: string;
  createdAt: number;
  requestPayload: null;
  responsePayload: null;
  provider?: string | null;
  summary?: LLMCallSummary | null;
  requestSections?: LLMContextSection[] | null;
  responseSections?: LLMContextSection[] | null;
}

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
 * `GET /v1/messages/{messageId}/llm-context`. Hydrates the Overview /
 * Memory / Prompt / Response tabs from a single fetch.
 *
 * `conversationTotalEstimatedCostUsd` is the running total of priced
 * LLM costs across every call in the conversation, sourced from the
 * daemon's `conversations.total_estimated_cost` column. The field is
 * optional because older daemons predate it — treat undefined / null
 * as "unavailable".
 */
export interface LlmContextResponse {
  messageId: string;
  conversationKind: string;
  conversationTotalEstimatedCostUsd?: number | null;
  logs: LLMRequestLogEntry[];
  memoryRecall: MemoryRecallLog | null;
  memoryV2Activation: MemoryV2ActivationLog | null;
}
