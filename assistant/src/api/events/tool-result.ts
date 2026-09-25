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

import { ModeSessionSchema } from "../mode-session.js";
import {
  AllowlistOptionSchema,
  ConfirmationDiffSchema,
  DirectoryScopeOptionSchema,
} from "./confirmation-request.js";
import { AnsweredQuestionSchema } from "./question-answered.js";

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
  "fastcrw",
  "searxng",
  "tinyfish",
  "youcom",
]);

export type WebSearchProviderId = z.infer<typeof WebSearchProviderIdSchema>;

export const WebFetchProviderIdSchema = z.enum([
  "default",
  "firecrawl",
  "fastcrw",
  "tinyfish",
]);

export type WebFetchProviderId = z.infer<typeof WebFetchProviderIdSchema>;

export const WebSearchResultItemSchema = z.object({
  /** 1-indexed. */
  rank: z.number(),
  title: z.string(),
  url: z.string(),
  /** The lowercased host. */
  domain: z.string(),
  faviconUrl: z.string().optional(),
  /** Absent for `anthropic-native`, whose content is encrypted. */
  snippet: z.string().optional(),
  /** A freshness hint; Brave only. */
  age: z.string().optional(),
  /** Tavily only. */
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
  /**
   * The requested `start_index` was past the end of the page, so nothing was
   * read. Always set, true or false, by an assistant whose metadata carries
   * every warning a reader acts on (this and `providerWarning` included); a
   * record without it came from one that predates them, whose remaining
   * warnings are only in the result text.
   */
  startIndexPastEnd: z.boolean().optional(),
  /** A hosted provider's own warning about the fetch, verbatim. */
  providerWarning: z.string().optional(),
});

export type WebFetchMetadata = z.infer<typeof WebFetchMetadataSchema>;

/** A place `recall` searches. */
export const RecallSourceSchema = z.enum([
  "memory",
  "conversations",
  "workspace",
]);

export type RecallSource = z.infer<typeof RecallSourceSchema>;

/** How hard `recall` searches: more depth, more rounds across the sources. */
export const RecallDepthSchema = z.enum(["fast", "standard", "deep"]);

export type RecallDepth = z.infer<typeof RecallDepthSchema>;

/** One piece of evidence a `recall` result stands on. */
export const RecallEvidenceItemSchema = z.object({
  source: RecallSourceSchema,
  title: z.string(),
  /** Where in its source: a memory page, a conversation and when, a file and line. */
  locator: z.string(),
  /** The excerpt, collapsed to one line and cut to a few hundred characters. */
  excerpt: z.string(),
  timestampMs: z.number().optional(),
  /**
   * The workspace-relative file the item was found in, for a workspace file or
   * a memory page, so a client can open it.
   */
  path: z.string().optional(),
  /** The conversation the item was found in, so a client can open it. */
  conversationId: z.string().optional(),
  /** The message in that conversation, so a client can open it there. */
  messageId: z.string().optional(),
});

export type RecallEvidenceItem = z.infer<typeof RecallEvidenceItemSchema>;

/** How one source fared: searched, or degraded with the reason. */
export const RecallSearchedSourceSchema = z.object({
  source: RecallSourceSchema,
  status: z.enum(["searched", "degraded"]),
  evidenceCount: z.number(),
  error: z.string().optional(),
});

export type RecallSearchedSource = z.infer<typeof RecallSearchedSourceSchema>;

/**
 * A `recall` call as structured data: what it searched for and how, the answer
 * when one was written, the evidence it stands on, and how each source fared.
 * The same result the tool's text gives the model, for a client to lay out.
 */
export const RecallMetadataSchema = z.object({
  query: z.string(),
  depth: RecallDepthSchema,
  sources: z.array(RecallSourceSchema),
  /**
   * The answer written from the evidence. Absent when recall fell back to
   * listing what it found, or found nothing.
   */
  answer: z.string().optional(),
  evidence: z.array(RecallEvidenceItemSchema),
  searchedSources: z.array(RecallSearchedSourceSchema),
});

export type RecallMetadata = z.infer<typeof RecallMetadataSchema>;

/** A `remember` call as structured data: the facts it saved, as written. */
export const RememberMetadataSchema = z.object({
  facts: z.array(z.string()),
});

export type RememberMetadata = z.infer<typeof RememberMetadataSchema>;

export const ToolActivityMetadataSchema = z.object({
  webSearch: WebSearchMetadataSchema.optional(),
  webFetch: WebFetchMetadataSchema.optional(),
  recall: RecallMetadataSchema.optional(),
  remember: RememberMetadataSchema.optional(),
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
  modeSession: ModeSessionSchema.optional(),
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
   * Set only by `ask_question`: the questions asked and the answers the user
   * gave. Carried here so the answered card renders the instant the prompt
   * resolves, from the same record the daemon persists on the tool_use block.
   */
  answeredQuestion: AnsweredQuestionSchema.optional(),
  /**
   * Stable, machine-readable classification for an error result (only set when
   * `isError`). Lets a client branch on a known failure — e.g.
   * `acp_claude_oauth_missing`, which renders an inline "Connect Claude Code"
   * affordance — instead of pattern-matching the human `result` string. Absent
   * on streams from older daemons and for results with no structured code.
   */
  errorCode: z.string().optional(),
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
