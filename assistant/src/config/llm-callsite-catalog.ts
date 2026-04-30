import type { LLMCallSite } from "./schemas/llm.js";

export interface LLMCallSiteCatalogEntry {
  label: string;
}

export const LLM_CALLSITE_CATALOG: Record<
  LLMCallSite,
  LLMCallSiteCatalogEntry
> = {
  mainAgent: { label: "Main agent" },
  subagentSpawn: { label: "Subagent spawn" },
  heartbeatAgent: { label: "Heartbeat agent" },
  filingAgent: { label: "Filing agent" },
  compactionAgent: { label: "Context compactor" },
  analyzeConversation: { label: "Analyze conversation" },
  callAgent: { label: "Call agent" },
  memoryExtraction: { label: "Memory extraction" },
  memoryConsolidation: { label: "Memory consolidation" },
  memoryRetrieval: { label: "Memory retrieval" },
  memoryV2Migration: { label: "Memory migration" },
  memoryV2Sweep: { label: "Memory sweep" },
  recall: { label: "Recall" },
  narrativeRefinement: { label: "Narrative refinement" },
  patternScan: { label: "Pattern scan" },
  conversationSummarization: { label: "Conversation summarization" },
  conversationStarters: { label: "Conversation starters" },
  conversationTitle: { label: "Conversation title" },
  commitMessage: { label: "Commit message" },
  identityIntro: { label: "Identity intro" },
  emptyStateGreeting: { label: "Empty-state greeting" },
  notificationDecision: { label: "Notification decision" },
  preferenceExtraction: { label: "Preference extraction" },
  guardianQuestionCopy: { label: "Guardian question copy" },
  approvalCopy: { label: "Approval copy" },
  approvalConversation: { label: "Approval conversation" },
  interactionClassifier: { label: "Interaction classifier" },
  styleAnalyzer: { label: "Style analyzer" },
  inviteInstructionGenerator: { label: "Invite instruction generator" },
  skillCategoryInference: { label: "Skill category inference" },
  meetConsentMonitor: { label: "Meet consent monitor" },
  meetChatOpportunity: { label: "Meet chat opportunity" },
  inference: { label: "Inference" },
  feedEventCopy: { label: "Feed event copy" },
  trustRuleSuggestion: { label: "Trust rule suggestion" },
};

export function getLLMCallSiteLabel(callSite: LLMCallSite | string): string {
  return (
    LLM_CALLSITE_CATALOG[callSite as LLMCallSite]?.label ?? String(callSite)
  );
}
