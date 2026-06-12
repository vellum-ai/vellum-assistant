import { type LLMCallSite } from "./schemas/llm.js";

type CallSiteDefaultConfig = {
  profile: string;
  maxTokens?: number;
  effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  temperature?: number | null;
  thinking?: { enabled?: boolean; streamThinking?: boolean };
  contextWindow?: { maxInputTokens?: number };
};

export const CALL_SITE_DEFAULTS: Record<LLMCallSite, CallSiteDefaultConfig> = {
  mainAgent: { profile: "balanced" },
  subagentSpawn: { profile: "balanced" },
  compactionAgent: { profile: "balanced" },
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
  conversationTitle: { profile: "cost-optimized" },
  approvalCopy: { profile: "cost-optimized" },
  approvalConversation: { profile: "cost-optimized" },
  trustRuleSuggestion: { profile: "cost-optimized" },
  styleAnalyzer: { profile: "cost-optimized" },
  meetConsentMonitor: { profile: "cost-optimized" },
  meetChatOpportunity: { profile: "cost-optimized" },
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
    effort: "low",
    thinking: { enabled: false },
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
  },
  homeSuggestedPrompts: {
    profile: "cost-optimized",
    maxTokens: 512,
    effort: "low",
    thinking: { enabled: false },
  },
  workflowLeaf: {
    profile: "cost-optimized",
    effort: "low",
    thinking: { enabled: false },
  },
};
