/**
 * `tool_result` SSE event.
 *
 * Emitted by the daemon's agent loop when a tool invocation finishes —
 * carries the textual result, optional risk metadata for trust-rule
 * evaluation, and correlation ids for the conversation, the message,
 * and the tool_use block.
 *
 * The three risk-option arrays are distinct contracts:
 *  - `riskAllowlistOptions` — Minimatch-glob save-path patterns; what
 *    the rule editor's "Apply to" radio group persists as a trust
 *    rule's `pattern`. Mirrors `ConfirmationRequestEvent.allowlistOptions`.
 *  - `riskScopeOptions` — display-only ladder whose `pattern` is
 *    regex-flavored and NOT a valid trust rule pattern; clients must
 *    not feed it into the save path. Shape differs from the canonical
 *    `ScopeOption` (`{ pattern, label }` vs `{ label, scope }`), so it
 *    has its own schema here.
 *  - `riskDirectoryScopeOptions` — directory scope ladder for the rule
 *    editor modal.
 *
 * `activityMetadata` is structured live activity for rich client
 * rendering (web_search / web_fetch); clients that key off `result`
 * continue to work unchanged.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

import {
  AllowlistOptionSchema,
  ConfirmationDiffSchema,
  DirectoryScopeOptionSchema,
} from "./confirmation-request.js";

export const RiskScopeOptionSchema = z.object({
  pattern: z.string(),
  label: z.string(),
});

export type RiskScopeOption = z.infer<typeof RiskScopeOptionSchema>;

export const WebSearchProviderIdSchema = z.enum([
  "anthropic-native",
  "brave",
  "perplexity",
  "tavily",
  "keenable",
  "firecrawl",
]);

export type WebSearchProviderId = z.infer<typeof WebSearchProviderIdSchema>;

export const WebFetchProviderIdSchema = z.enum(["default", "firecrawl"]);

export type WebFetchProviderId = z.infer<typeof WebFetchProviderIdSchema>;

export const WebSearchResultItemSchema = z.object({
  rank: z.number(),
  title: z.string(),
  url: z.string(),
  domain: z.string(),
  faviconUrl: z.string().optional(),
  snippet: z.string().optional(),
  age: z.string().optional(),
  score: z.number().optional(),
});

export type WebSearchResultItem = z.infer<typeof WebSearchResultItemSchema>;

export const WebSearchMetadataSchema = z.object({
  query: z.string(),
  provider: WebSearchProviderIdSchema,
  resultCount: z.number(),
  durationMs: z.number(),
  results: z.array(WebSearchResultItemSchema),
  errorMessage: z.string().optional(),
});

export type WebSearchMetadata = z.infer<typeof WebSearchMetadataSchema>;

export const WebFetchMetadataSchema = z.object({
  url: z.string(),
  finalUrl: z.string(),
  provider: WebFetchProviderIdSchema.optional(),
  status: z.number(),
  contentType: z.string().optional(),
  byteCount: z.number(),
  charCount: z.number(),
  truncated: z.boolean(),
  title: z.string().optional(),
  domain: z.string(),
  faviconUrl: z.string().optional(),
  redirectCount: z.number(),
  durationMs: z.number(),
  errorMessage: z.string().optional(),
  mayRequireJavaScript: z.boolean().optional(),
});

export type WebFetchMetadata = z.infer<typeof WebFetchMetadataSchema>;

export const ToolActivityMetadataSchema = z.object({
  webSearch: WebSearchMetadataSchema.optional(),
  webFetch: WebFetchMetadataSchema.optional(),
});

export type ToolActivityMetadata = z.infer<typeof ToolActivityMetadataSchema>;

export const ToolResultEventSchema = z.object({
  type: z.literal("tool_result"),
  toolName: z.string(),
  result: z.string(),
  isError: z.boolean().optional(),
  diff: ConfirmationDiffSchema.optional(),
  status: z.string().optional(),
  conversationId: z.string().optional(),
  imageData: z.string().optional(),
  imageDataList: z.array(z.string()).optional(),
  toolUseId: z.string().optional(),
  messageId: z.string().optional(),
  riskLevel: z.string().optional(),
  riskReason: z.string().optional(),
  matchedTrustRuleId: z.string().optional(),
  isContainerized: z.boolean().optional(),
  riskScopeOptions: z.array(RiskScopeOptionSchema).optional(),
  riskAllowlistOptions: z.array(AllowlistOptionSchema).optional(),
  riskDirectoryScopeOptions: z.array(DirectoryScopeOptionSchema).optional(),
  approvalMode: z.string().optional(),
  approvalReason: z.string().optional(),
  riskThreshold: z.string().optional(),
  activityMetadata: ToolActivityMetadataSchema.optional(),
  /**
   * Unix ms when the daemon finished executing the tool. Pairs with
   * `ToolUseStartEvent.startedAt` so clients can render a final duration that
   * stays on the daemon's clock, matching the live elapsed-time counter and
   * avoiding skew between a server-stamped start and a browser-stamped end.
   * Absent on streams from older daemons; clients fall back to their own
   * receipt time.
   */
  completedAt: z.number().optional(),
});

export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;
