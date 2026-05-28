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
});

export type LLMRequestLogEntry = z.infer<typeof LLMRequestLogEntrySchema>;
