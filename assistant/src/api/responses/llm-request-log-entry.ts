/**
 * Wire contract for a single LLM request log row, as returned by
 * `GET /v1/conversations/llm-context`. Hydrates each call rail entry
 * + tab in the inspector.
 *
 * Canonical wire-contract source. Assistant code imports the types
 * directly from this file via relative paths; external consumers (web
 * client, gateway, evals) import via `@vellumai/assistant-api`.
 *
 * The route is implemented in
 * `assistant/src/runtime/routes/conversation-query-routes.ts` and the
 * row shape is constructed by `normalizeLlmContextLog` there. Keep this
 * file aligned with that constructor — the type IS the contract.
 *
 * `requestPayload` / `responsePayload` are always `null` on the list
 * endpoint; raw JSON is fetched lazily through
 * `/v1/llm-request-logs/{logId}/payload`.
 */

/**
 * Provider-normalized summary attached to each request log. `null` /
 * missing fields are common — formatters fall back to a shared
 * "Unavailable" placeholder.
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
 * One LLM request log row.
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
  agentLoopExitReason?: string | null;
  /**
   * Logical call site that produced this row — `mainAgent`,
   * `compactionAgent`, `syntheticAgentErrorMessage`, etc. `null` on
   * pre-migration-264 rows or callers that hadn't been wired through
   * yet. The inspector branches on this value alone to distinguish
   * real LLM calls from synthetic error-message rows. See
   * `../constants/call-sites.ts` for the canonical identifiers.
   */
  callSite?: string | null;
}
