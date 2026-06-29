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
 * row shape is constructed by `normalizeLlmContextLog` there. Keep the
 * schemas here aligned with that constructor — the schema IS the
 * contract; types are `z.infer`-derived.
 *
 * `requestPayload` / `responsePayload` are always `null` on the list
 * endpoint; raw JSON is fetched lazily through
 * `/v1/llm-request-logs/{logId}/payload`.
 */

import { z } from "zod";

/**
 * One segment of the turn's first-token latency waterfall. `key` is a
 * stable machine id (`queue`, `memory_context`, `ttft`, …); `label` is
 * the human row title; `ms` is the wall-clock duration of that phase.
 */
export const LatencyPhaseSchema = z.object({
  key: z.string(),
  label: z.string(),
  ms: z.number(),
});

export type LatencyPhase = z.infer<typeof LatencyPhaseSchema>;

/**
 * Per-call latency breakdown for a main-agent LLM call, measured by the
 * daemon and stored on the `llm_request_logs` row. `phases` is the
 * ordered waterfall from turn receipt to call completion (queue → memory
 * & context retrieval → setup → request prep → time-to-first-token →
 * generation); the scalar fields are the headline numbers derived from
 * it. `totalToFirstTokenMs` is only present on the first call of a turn —
 * later calls (tool-use loops) carry just their own per-call segment.
 * `firstTokenKind` records whether the first streamed token was a
 * thinking or text delta.
 */
export const LatencyBreakdownSchema = z.object({
  phases: z.array(LatencyPhaseSchema),
  ttftMs: z.number().nullish(),
  totalToFirstTokenMs: z.number().nullish(),
  providerDurationMs: z.number().nullish(),
  firstTokenKind: z.enum(["thinking", "text"]).nullish(),
});

export type LatencyBreakdown = z.infer<typeof LatencyBreakdownSchema>;

/**
 * Provider-normalized summary attached to each request log. `null` /
 * missing fields are common — formatters fall back to a shared
 * "Unavailable" placeholder.
 *
 * `durationMs` isn't in the macOS reference shape today but the daemon
 * already populates it for some providers — surfaced when present so
 * web debugging gets the extra signal.
 */
export const LLMCallSummarySchema = z.object({
  provider: z.string().nullish(),
  model: z.string().nullish(),
  status: z.string().nullish(),
  inputTokens: z.number().nullish(),
  outputTokens: z.number().nullish(),
  cacheCreationInputTokens: z.number().nullish(),
  cacheReadInputTokens: z.number().nullish(),
  stopReason: z.string().nullish(),
  requestMessageCount: z.number().nullish(),
  requestToolCount: z.number().nullish(),
  responseMessageCount: z.number().nullish(),
  responseToolCallCount: z.number().nullish(),
  responsePreview: z.string().nullish(),
  toolCallNames: z.array(z.string()).nullish(),
  estimatedCostUsd: z.number().nullish(),
  durationMs: z.number().nullish(),
});

export type LLMCallSummary = z.infer<typeof LLMCallSummarySchema>;

/**
 * A single normalized request- or response-side section. The daemon
 * splits a provider payload into kind-tagged blocks before returning;
 * each block becomes one card in the Prompt / Response tabs.
 */
export const LLMContextSectionSchema = z.object({
  kind: z.string(),
  label: z.string().nullish(),
  role: z.string().nullish(),
  text: z.string().nullish(),
  toolName: z.string().nullish(),
  data: z.unknown().optional(),
  language: z.string().nullish(),
});

export type LLMContextSection = z.infer<typeof LLMContextSectionSchema>;

/**
 * Structured provider/transport error recorded when an LLM call was
 * rejected before producing a response. Mirrors the on-disk
 * `responsePayload.error` shape written by
 * `buildProviderErrorResponsePayload` — the inspector branches on the
 * presence of this field to render a failed call distinctly (failure
 * banner in the Response tab, $0.00 cost in the rail, etc.) instead of
 * the generic "section rendering unavailable" fallback.
 *
 * Every field is optional because the serializer degrades a plain
 * `Error` down to just `{ name, message }`; only the wrapper object is
 * guaranteed.
 */
export const LLMCallErrorSchema = z.object({
  name: z.string().nullish(),
  message: z.string().nullish(),
  code: z.string().nullish(),
  provider: z.string().nullish(),
  statusCode: z.number().nullish(),
  retryAfterMs: z.number().nullish(),
  apiErrorCode: z.string().nullish(),
  apiErrorType: z.string().nullish(),
  apiErrorParam: z.string().nullish(),
  requestId: z.string().nullish(),
});

export type LLMCallError = z.infer<typeof LLMCallErrorSchema>;

/**
 * One LLM request log row.
 *
 * `callSite` is the logical call site that produced this row —
 * `mainAgent`, `compactionAgent`, `syntheticAgentErrorMessage`, etc.
 * `null` on pre-migration-264 rows or callers that hadn't been wired
 * through yet. The inspector branches on this value alone to
 * distinguish real LLM calls from synthetic error-message rows. See
 * `../constants/call-sites.ts` for the canonical identifiers.
 */
export const LLMRequestLogEntrySchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  requestPayload: z.null(),
  responsePayload: z.null(),
  provider: z.string().nullish(),
  summary: LLMCallSummarySchema.nullish(),
  requestSections: z.array(LLMContextSectionSchema).nullish(),
  responseSections: z.array(LLMContextSectionSchema).nullish(),
  agentLoopExitReason: z.string().nullish(),
  callSite: z.string().nullish(),
  error: LLMCallErrorSchema.nullish(),
  /**
   * Daemon-measured first-token latency waterfall for this call. Present on
   * main-agent calls recorded after the instrumentation shipped; `null` on
   * older rows, failed calls, and non-main-agent call sites. Stamped on the
   * row (like `callSite`), not derived from the request/response payloads.
   */
  latency: LatencyBreakdownSchema.nullish(),
});

export type LLMRequestLogEntry = z.infer<typeof LLMRequestLogEntrySchema>;
