import { type LLMCallSite } from "./llm.js";

export const CALL_SITE_DOMAINS = [
  { id: "agentLoop", displayName: "Agent Loop" },
  { id: "memory", displayName: "Memory" },
  { id: "workspace", displayName: "Workspace" },
  { id: "ui", displayName: "UI" },
  { id: "notifications", displayName: "Notifications" },
  { id: "skills", displayName: "Skills" },
] as const;

export type CallSiteDomainId = (typeof CALL_SITE_DOMAINS)[number]["id"];

export interface CallSiteDomainEntry {
  id: CallSiteDomainId;
  displayName: string;
}

export interface CallSiteEntry {
  id: LLMCallSite;
  displayName: string;
  description: string;
  domain: CallSiteDomainId;
}

/**
 * Keyed by every member of LLMCallSite. TypeScript enforces exhaustiveness:
 * adding or removing a value from LLMCallSiteEnum without updating this object
 * is a compile error — no runtime drift guard needed.
 */
type CatalogRecord = {
  [K in LLMCallSite]: {
    id: K;
    displayName: string;
    description: string;
    domain: CallSiteDomainId;
  };
};

const CATALOG_RECORD: CatalogRecord = {
  // agentLoop
  mainAgent: {
    id: "mainAgent",
    displayName: "Main Agent",
    description: "The primary conversation agent that handles user messages.",
    domain: "agentLoop",
  },
  subagentSpawn: {
    id: "subagentSpawn",
    displayName: "Subagent Spawn",
    description: "Spawns a subagent to handle a delegated subtask.",
    domain: "agentLoop",
  },
  heartbeatAgent: {
    id: "heartbeatAgent",
    displayName: "Heartbeat Agent",
    description: "Runs background tasks and proactive checks on a schedule.",
    domain: "agentLoop",
  },
  filingAgent: {
    id: "filingAgent",
    displayName: "Filing Agent",
    description:
      "Files memories and updates the knowledge base after conversations.",
    domain: "agentLoop",
  },
  compactionAgent: {
    id: "compactionAgent",
    displayName: "Compaction Agent",
    description: "Compacts conversation history to stay within context limits.",
    domain: "agentLoop",
  },
  analyzeConversation: {
    id: "analyzeConversation",
    displayName: "Analyze Conversation",
    description: "Analyzes conversation content for summaries and insights.",
    domain: "agentLoop",
  },
  callAgent: {
    id: "callAgent",
    displayName: "Call Agent",
    description: "Handles voice call conversations.",
    domain: "agentLoop",
  },

  // memory
  memoryExtraction: {
    id: "memoryExtraction",
    displayName: "Memory Extraction",
    description: "Extracts memorable facts from conversation turns.",
    domain: "memory",
  },
  memoryConsolidation: {
    id: "memoryConsolidation",
    displayName: "Memory Consolidation",
    description: "Merges and deduplicates related memories.",
    domain: "memory",
  },
  memoryRetrieval: {
    id: "memoryRetrieval",
    displayName: "Memory Retrieval",
    description: "Retrieves relevant memories to augment the agent context.",
    domain: "memory",
  },
  memoryV2Migration: {
    id: "memoryV2Migration",
    displayName: "Memory V2 Migration",
    description: "One-time migration of memories to the V2 storage format.",
    domain: "memory",
  },
  memoryV2Sweep: {
    id: "memoryV2Sweep",
    displayName: "Memory V2 Sweep",
    description: "Background sweep pass for V2 memory maintenance.",
    domain: "memory",
  },
  recall: {
    id: "recall",
    displayName: "Recall",
    description: "Searches memory to answer a specific question during a turn.",
    domain: "memory",
  },
  narrativeRefinement: {
    id: "narrativeRefinement",
    displayName: "Narrative Refinement",
    description: "Refines the autobiographical narrative stored in memory.",
    domain: "memory",
  },
  patternScan: {
    id: "patternScan",
    displayName: "Pattern Scan",
    description: "Scans memories for recurring behavioral patterns.",
    domain: "memory",
  },

  // workspace
  conversationSummarization: {
    id: "conversationSummarization",
    displayName: "Conversation Summarization",
    description: "Generates a summary of a completed conversation.",
    domain: "workspace",
  },
  commitMessage: {
    id: "commitMessage",
    displayName: "Commit Message",
    description: "Generates a git commit message for staged changes.",
    domain: "workspace",
  },

  // ui
  conversationStarters: {
    id: "conversationStarters",
    displayName: "Conversation Starters",
    description:
      "Generates the personalized starter chips on the empty conversation page.",
    domain: "ui",
  },
  replySuggestion: {
    id: "replySuggestion",
    displayName: "Reply Suggestion",
    description:
      "Generates the tab-to-accept reply hint shown in the chat composer after each assistant turn.",
    domain: "ui",
  },
  conversationTitle: {
    id: "conversationTitle",
    displayName: "Conversation Title",
    description: "Generates a title for a conversation from its content.",
    domain: "ui",
  },
  identityIntro: {
    id: "identityIntro",
    displayName: "Identity Intro",
    description: "Generates the assistant's introductory identity text.",
    domain: "ui",
  },
  emptyStateGreeting: {
    id: "emptyStateGreeting",
    displayName: "Empty State Greeting",
    description: "Generates a greeting shown on the empty conversation screen.",
    domain: "ui",
  },
  guardianQuestionCopy: {
    id: "guardianQuestionCopy",
    displayName: "Guardian Question Copy",
    description: "Generates copy for guardian onboarding questions.",
    domain: "ui",
  },
  approvalCopy: {
    id: "approvalCopy",
    displayName: "Approval Copy",
    description: "Generates copy for tool approval prompts shown to the user.",
    domain: "ui",
  },
  approvalConversation: {
    id: "approvalConversation",
    displayName: "Approval Conversation",
    description: "Handles conversational approval flows.",
    domain: "ui",
  },
  feedEventCopy: {
    id: "feedEventCopy",
    displayName: "Feed Event Copy",
    description: "Generates copy for home feed event cards.",
    domain: "ui",
  },
  trustRuleSuggestion: {
    id: "trustRuleSuggestion",
    displayName: "Trust Rule Suggestion",
    description:
      "Suggests a trust rule pattern when the user creates a new rule.",
    domain: "ui",
  },

  // notifications
  notificationDecision: {
    id: "notificationDecision",
    displayName: "Notification Decision",
    description:
      "Decides whether a background event warrants sending a notification.",
    domain: "notifications",
  },
  preferenceExtraction: {
    id: "preferenceExtraction",
    displayName: "Preference Extraction",
    description:
      "Extracts notification and communication preferences from messages.",
    domain: "notifications",
  },

  // skills
  interactionClassifier: {
    id: "interactionClassifier",
    displayName: "Interaction Classifier",
    description: "Classifies the type of interaction to route it correctly.",
    domain: "skills",
  },
  styleAnalyzer: {
    id: "styleAnalyzer",
    displayName: "Style Analyzer",
    description: "Analyzes the user's communication style for personalization.",
    domain: "skills",
  },
  inviteInstructionGenerator: {
    id: "inviteInstructionGenerator",
    displayName: "Invite Instruction Generator",
    description: "Generates setup instructions for new skill invites.",
    domain: "skills",
  },
  skillCategoryInference: {
    id: "skillCategoryInference",
    displayName: "Skill Category Inference",
    description: "Infers the category of a skill from its description.",
    domain: "skills",
  },
  meetConsentMonitor: {
    id: "meetConsentMonitor",
    displayName: "Meet Consent Monitor",
    description: "Monitors meeting consent signals during live calls.",
    domain: "skills",
  },
  meetChatOpportunity: {
    id: "meetChatOpportunity",
    displayName: "Meet Chat Opportunity",
    description: "Identifies opportunities to engage in meeting chat.",
    domain: "skills",
  },
  inference: {
    id: "inference",
    displayName: "Inference",
    description: "General-purpose LLM inference call site for skill use.",
    domain: "skills",
  },
  proactiveArtifactDecision: {
    id: "proactiveArtifactDecision",
    displayName: "Proactive Artifact Decision",
    description:
      "Decides what personalized artifact to build for new users based on conversation context.",
    domain: "agentLoop",
  },
  proactiveArtifactBuild: {
    id: "proactiveArtifactBuild",
    displayName: "Proactive Artifact Build",
    description:
      "Builds the personalized artifact in a background conversation with tool access.",
    domain: "agentLoop",
  },
};

// Source of truth for call-site display metadata. API responses and usage
// display paths should reuse this catalog instead of defining separate labels.
export const CALL_SITE_CATALOG: CallSiteEntry[] = Object.values(CATALOG_RECORD);
