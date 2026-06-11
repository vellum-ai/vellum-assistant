import { type LLMCallSite } from "./schemas/llm.js";

type CallSiteDefaultConfig = {
  profile: string;
  maxTokens?: number;
  effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  temperature?: number | null;
  thinking?: { enabled?: boolean; streamThinking?: boolean };
  contextWindow?: { maxInputTokens?: number };
  /**
   * When true, this call site resolves with EXACTLY `mainAgent`'s precedence:
   * the workspace `activeProfile` and per-call `overrideProfile` float ABOVE
   * any static `llm.callSites[id]` override, producing a config byte-identical
   * to what `mainAgent` would resolve for the same `opts`. Used by call sites
   * that must follow the user's chat-model selection turn-for-turn — e.g.
   * `compactionAgent`, whose resolved provider/model/system-prompt/tools must
   * match the agent's last turn to keep the prefix cache warm.
   *
   * The resolver enforces a `{ profile }`-only entry (no tuning fields) for
   * flagged sites so the byte-identical guarantee holds: any tuning here would
   * diverge from mainAgent. See `resolveCallSiteConfig`.
   */
  resolvesLikeMainAgent?: boolean;
};

export const CALL_SITE_DEFAULTS: Record<LLMCallSite, CallSiteDefaultConfig> = {
  mainAgent: { profile: "balanced" },
  subagentSpawn: { profile: "balanced" },
  // Conversation-history compactor only (`context/compactor.ts`). Resolves
  // exactly like `mainAgent` (active/override profiles float above any static
  // override) so the compaction call inherits the agent's chat-model selection
  // and keeps the prefix cache warm — see `resolvesLikeMainAgent`. The daily PKB
  // filing-compaction background job is a DIFFERENT action with no cache
  // requirement: it has its own `filingCompaction` site (balanced, no float).
  compactionAgent: { profile: "balanced", resolvesLikeMainAgent: true },
  analyzeConversation: { profile: "balanced" },
  patternScan: { profile: "balanced" },
  narrativeRefinement: { profile: "balanced" },
  callAgent: { profile: "balanced" },
  memoryConsolidation: { profile: "balanced" },
  identityIntro: { profile: "balanced" },
  emptyStateGreeting: { profile: "balanced" },

  memoryRouter: {
    profile: "cost-optimized",
    contextWindow: { maxInputTokens: 1000000 },
  },
  memoryV3SelectL2: { profile: "balanced", temperature: 0 },
  recall: {
    profile: "balanced",
    maxTokens: 4096,
    effort: "low",
    thinking: { enabled: false, streamThinking: false },
    temperature: 0,
  },
  conversationStarters: {
    profile: "balanced",
    maxTokens: 2048,
    temperature: 0.7,
    effort: "low",
    thinking: { enabled: false },
  },

  filingAgent: { profile: "cost-optimized" },
  // Daily PKB filing-compaction background job (`filing/filing-service.ts`).
  // Distinct from the conversation-history `compactionAgent`: no prefix-cache
  // requirement, so it does NOT follow the user's chat-model selection. Keep
  // this at `{ profile: "balanced" }` to preserve its pre-M7 resolution exactly
  // (it shared `compactionAgent`'s `{ profile: "balanced" }` default before that
  // site became `resolvesLikeMainAgent`).
  filingCompaction: { profile: "balanced" },
  memoryExtraction: { profile: "cost-optimized" },
  // Rerank/dedup passes (retriever.ts) need deterministic output and no
  // extended thinking; `temperature: 0` requires thinking disabled because
  // Anthropic 400s on `temperature` ≠ 1 when thinking is enabled/adaptive.
  memoryRetrieval: {
    profile: "cost-optimized",
    temperature: 0,
    thinking: { enabled: false, streamThinking: false },
  },
  memoryRetrospective: { profile: "cost-optimized" },
  memoryV2Migration: { profile: "cost-optimized" },
  memoryV2Sweep: { profile: "cost-optimized" },
  memoryV2Consolidation: { profile: "balanced" },
  conversationSummarization: { profile: "cost-optimized", maxTokens: 1000 },
  conversationTitle: { profile: "cost-optimized" },
  approvalCopy: { profile: "cost-optimized" },
  approvalConversation: { profile: "cost-optimized" },
  trustRuleSuggestion: { profile: "cost-optimized", maxTokens: 512 },
  styleAnalyzer: { profile: "cost-optimized" },
  meetConsentMonitor: { profile: "cost-optimized" },
  meetChatOpportunity: { profile: "cost-optimized" },
  mediaReduce: { profile: "cost-optimized" },
  inference: { profile: "cost-optimized" },

  heartbeatAgent: {
    profile: "cost-optimized",
  },
  commitMessage: {
    profile: "cost-optimized",
    maxTokens: 120,
    temperature: 0.2,
    effort: "low",
    thinking: { enabled: false },
  },
  replySuggestion: {
    profile: "cost-optimized",
    maxTokens: 60,
    temperature: 0.7,
    // thinking-disabled keeps the 60-token reply chip working on any user
    // profile — `temperature` ≠ 1 requires thinking disabled (Anthropic 400s
    // otherwise), and a short chip gains nothing from thinking.
    //
    // `effort` is intentionally NOT set here: the call site (suggestion route
    // in conversation-routes.ts) sets `effort: "none"` inline as a per-request
    // operational invariant that must unconditionally win over the migration-
    // 072-seeded `effort: "low"` persisted fragment. A default `effort` here
    // would be overridden by that seeded `low` under the per-field merge in
    // `resolveCallSiteConfig` (shipped tuning sits UNDER the persisted entry),
    // diverging from the pre-M4 wire value of `none`.
    thinking: { enabled: false },
  },
  guardianQuestionCopy: {
    profile: "cost-optimized",
    effort: "low",
    thinking: { enabled: false },
  },
  notificationDecision: {
    profile: "cost-optimized",
    maxTokens: 2048,
    effort: "low",
    thinking: { enabled: false },
  },
  preferenceExtraction: {
    profile: "cost-optimized",
    maxTokens: 1024,
    effort: "low",
    thinking: { enabled: false },
  },
  interactionClassifier: {
    profile: "cost-optimized",
    effort: "low",
    thinking: { enabled: false },
  },
  inviteInstructionGenerator: {
    profile: "cost-optimized",
    effort: "low",
    thinking: { enabled: false },
  },
  skillCategoryInference: {
    profile: "cost-optimized",
    maxTokens: 256,
    effort: "low",
    thinking: { enabled: false },
  },
  homeGreeting: {
    profile: "cost-optimized",
    maxTokens: 60,
    effort: "low",
    thinking: { enabled: false },
    temperature: 0.7,
  },
  homeSuggestedPrompts: {
    profile: "cost-optimized",
    maxTokens: 512,
    effort: "low",
    thinking: { enabled: false },
  },
};
