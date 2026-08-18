import { type LLMCallSite } from "./schemas/llm.js";

type CallSiteDefaultConfig = {
  /**
   * Named profile the call site resolves to. Omit to fall through to the
   * balanced intent resolved through `llm.defaultProvider` — used for call
   * sites that must resolve to a credentialed provider on every install
   * rather than pinning a profile that may be unavailable.
   */
  profile?: string;
  /**
   * Direct model pin overriding the resolved profile's model. The resolver
   * treats a bare model pin as catalog-implied: it stamps the model's
   * catalog provider and keeps the provider-agnostic Vellum managed
   * connection (see `resolveOverrideOrDefault`). Reserve for call sites
   * whose latency envelope the profile's model cannot meet.
   */
  model?: string;
  maxTokens?: number;
  effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  temperature?: number | null;
  thinking?: { enabled?: boolean; streamThinking?: boolean };
  contextWindow?: { maxInputTokens?: number };
  /**
   * Opt the call site out of prompt caching. Set for one-shot call sites
   * whose prompts never repeat — or repeat slower than the cache TTL — so
   * each call would pay the cache-write premium without a future read.
   * Telemetry confirms ~0–5% cache hit rates on these sites.
   */
  disableCache?: boolean;
};

export const CALL_SITE_DEFAULTS: Record<LLMCallSite, CallSiteDefaultConfig> = {
  mainAgent: { profile: "balanced" },
  subagentSpawn: { profile: "balanced" },
  compactionAgent: { profile: "balanced" },
  patternScan: { profile: "balanced" },
  narrativeRefinement: { profile: "balanced" },
  callAgent: { profile: "balanced" },
  memoryConsolidation: { profile: "balanced", disableCache: true },
  identityIntro: { profile: "balanced" },
  emptyStateGreeting: { profile: "balanced" },

  memoryRouter: {
    profile: "cost-optimized",
    contextWindow: { maxInputTokens: 1000000 },
  },
  // Forced-tool selection over a numbered candidate pool: the model picks ids,
  // it does not reason its way to an answer. `effort` has to be named here
  // because a call-site tweak only overrides the fields it lists, so leaving it
  // off inherits `balanced`'s `effort: "high"` (see default-profile-catalog).
  // Low effort matches `recall`, the sibling site doing the same kind of
  // bounded judgment, and keeps retrieval latency low on escalated voice turns.
  memoryV3SelectL2: {
    profile: "balanced",
    temperature: 0,
    effort: "low",
    thinking: { enabled: false, streamThinking: false },
  },
  recall: {
    profile: "balanced",
    maxTokens: 4096,
    effort: "low",
    thinking: { enabled: false, streamThinking: false },
    temperature: 0,
    disableCache: true,
  },
  conversationStarters: {
    profile: "balanced",
    effort: "low",
    thinking: { enabled: false },
  },

  filingAgent: { profile: "cost-optimized" },
  memoryExtraction: { profile: "cost-optimized" },
  memoryRetrieval: { profile: "cost-optimized" },
  memoryRetrospective: { profile: "cost-optimized" },
  memoryV2Migration: { profile: "cost-optimized" },
  memoryV2Sweep: { profile: "cost-optimized" },
  memoryV2Consolidation: { profile: "balanced" },
  conversationSummarization: { profile: "cost-optimized" },
  conversationTitle: { profile: "cost-optimized", disableCache: true },
  approvalCopy: { profile: "cost-optimized" },
  approvalConversation: { profile: "cost-optimized" },
  trustRuleSuggestion: { profile: "cost-optimized" },
  styleAnalyzer: { profile: "cost-optimized" },
  inference: { profile: "cost-optimized" },
  // Vision captioning for the image-fallback plugin. No pinned profile — the
  // plugin resolves a vision-capable profile itself via `doesSupportVision` and
  // passes it as an `overrideProfile`, so the call-site default is a fallback
  // that inherits the workspace default. Pinning a managed profile would break
  // BYOK installs where managed profiles are uncredentialed.
  vision: {},

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
    effort: "low",
    thinking: { enabled: false },
    disableCache: true,
  },
  guardianQuestionCopy: {
    profile: "cost-optimized",
    effort: "low",
    thinking: { enabled: false },
  },
  notificationDecision: {
    profile: "cost-optimized",
    effort: "low",
    thinking: { enabled: false },
  },
  preferenceExtraction: {
    profile: "cost-optimized",
    effort: "low",
    thinking: { enabled: false },
  },
  interactionClassifier: {
    profile: "cost-optimized",
    effort: "low",
    thinking: { enabled: false },
  },
  // Progress narration only helps when it arrives before the next real output.
  // `latency-optimized` is the latency-class profile (see
  // default-profile-catalog.ts): managed installs get the pinned latency model,
  // BYOK installs resolve their own provider's latency model through the intent
  // table rather than a model id they may hold no credential for. The profile
  // is user-facing ("Speed"), so a user edit to it moves this call site too.
  voiceProgressNarration: {
    profile: "latency-optimized",
    effort: "low",
    thinking: { enabled: false },
  },
  // The front-door leg fronts EVERY unified live-voice turn and its leading
  // tokens ARE the endpointing/triage verdict, so both TTFT variance and
  // judgment quality gate the whole call. Live drives showed the
  // cost-optimized upstream with multi-second
  // cross-session TTFT tails and over-escalation of small talk under open-task
  // context pressure.
  voiceFrontDoor: {
    profile: "latency-optimized",
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
    effort: "low",
    thinking: { enabled: false },
  },
  homeGreeting: {
    profile: "cost-optimized",
    maxTokens: 60,
    effort: "low",
    thinking: { enabled: false },
    temperature: 0.7,
    disableCache: true,
  },
  homeSuggestedPrompts: {
    profile: "cost-optimized",
    maxTokens: 512,
    effort: "low",
    thinking: { enabled: false },
    disableCache: true,
  },
  // Anonymous and schema leaves inherit the workspace default config (no pinned
  // profile) so they always resolve to a credentialed provider. Pinning a
  // managed profile like `cost-optimized` breaks BYOK installs where the managed
  // profiles are uncredentialed. A per-leaf `profile` option or a `workflowLeaf`
  // call-site override still takes precedence for cost control.
  workflowLeaf: {
    effort: "low",
    thinking: { enabled: false },
  },
};
