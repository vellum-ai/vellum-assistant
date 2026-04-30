import { LLMCallSiteEnum } from "./llm.js";

export interface CallSiteDomainEntry {
  id: string;
  displayName: string;
}

export interface CallSiteEntry {
  id: string; // must be a member of LLMCallSiteEnum
  displayName: string;
  description: string;
  domain: string; // must match a CallSiteDomainEntry.id
}

export const CALL_SITE_DOMAINS: CallSiteDomainEntry[] = [
  { id: "agentLoop", displayName: "Agent Loop" },
  { id: "memory", displayName: "Memory" },
  { id: "workspace", displayName: "Workspace" },
  { id: "ui", displayName: "UI" },
  { id: "notifications", displayName: "Notifications" },
  { id: "skills", displayName: "Skills" },
];

export const CALL_SITE_CATALOG: CallSiteEntry[] = [
  // agentLoop
  { id: "mainAgent", displayName: "Main Agent", description: "The primary conversation agent that handles user messages.", domain: "agentLoop" },
  { id: "subagentSpawn", displayName: "Subagent Spawn", description: "Spawns a subagent to handle a delegated subtask.", domain: "agentLoop" },
  { id: "heartbeatAgent", displayName: "Heartbeat Agent", description: "Runs background tasks and proactive checks on a schedule.", domain: "agentLoop" },
  { id: "filingAgent", displayName: "Filing Agent", description: "Files memories and updates the knowledge base after conversations.", domain: "agentLoop" },
  { id: "compactionAgent", displayName: "Compaction Agent", description: "Compacts conversation history to stay within context limits.", domain: "agentLoop" },
  { id: "analyzeConversation", displayName: "Analyze Conversation", description: "Analyzes conversation content for summaries and insights.", domain: "agentLoop" },
  { id: "callAgent", displayName: "Call Agent", description: "Handles voice call conversations.", domain: "agentLoop" },

  // memory
  { id: "memoryExtraction", displayName: "Memory Extraction", description: "Extracts memorable facts from conversation turns.", domain: "memory" },
  { id: "memoryConsolidation", displayName: "Memory Consolidation", description: "Merges and deduplicates related memories.", domain: "memory" },
  { id: "memoryRetrieval", displayName: "Memory Retrieval", description: "Retrieves relevant memories to augment the agent context.", domain: "memory" },
  { id: "memoryV2Migration", displayName: "Memory V2 Migration", description: "One-time migration of memories to the V2 storage format.", domain: "memory" },
  { id: "memoryV2Sweep", displayName: "Memory V2 Sweep", description: "Background sweep pass for V2 memory maintenance.", domain: "memory" },
  { id: "recall", displayName: "Recall", description: "Searches memory to answer a specific question during a turn.", domain: "memory" },
  { id: "narrativeRefinement", displayName: "Narrative Refinement", description: "Refines the autobiographical narrative stored in memory.", domain: "memory" },
  { id: "patternScan", displayName: "Pattern Scan", description: "Scans memories for recurring behavioral patterns.", domain: "memory" },

  // workspace
  { id: "conversationSummarization", displayName: "Conversation Summarization", description: "Generates a summary of a completed conversation.", domain: "workspace" },
  { id: "commitMessage", displayName: "Commit Message", description: "Generates a git commit message for staged changes.", domain: "workspace" },

  // ui
  { id: "conversationStarters", displayName: "Conversation Starters", description: "Generates suggested conversation openers for the home screen.", domain: "ui" },
  { id: "conversationTitle", displayName: "Conversation Title", description: "Generates a title for a conversation from its content.", domain: "ui" },
  { id: "identityIntro", displayName: "Identity Intro", description: "Generates the assistant's introductory identity text.", domain: "ui" },
  { id: "emptyStateGreeting", displayName: "Empty State Greeting", description: "Generates a greeting shown on the empty conversation screen.", domain: "ui" },
  { id: "guardianQuestionCopy", displayName: "Guardian Question Copy", description: "Generates copy for guardian onboarding questions.", domain: "ui" },
  { id: "approvalCopy", displayName: "Approval Copy", description: "Generates copy for tool approval prompts shown to the user.", domain: "ui" },
  { id: "approvalConversation", displayName: "Approval Conversation", description: "Handles conversational approval flows.", domain: "ui" },
  { id: "feedEventCopy", displayName: "Feed Event Copy", description: "Generates copy for home feed event cards.", domain: "ui" },
  { id: "trustRuleSuggestion", displayName: "Trust Rule Suggestion", description: "Suggests a trust rule pattern when the user creates a new rule.", domain: "ui" },

  // notifications
  { id: "notificationDecision", displayName: "Notification Decision", description: "Decides whether a background event warrants sending a notification.", domain: "notifications" },
  { id: "preferenceExtraction", displayName: "Preference Extraction", description: "Extracts notification and communication preferences from messages.", domain: "notifications" },

  // skills
  { id: "interactionClassifier", displayName: "Interaction Classifier", description: "Classifies the type of interaction to route it correctly.", domain: "skills" },
  { id: "styleAnalyzer", displayName: "Style Analyzer", description: "Analyzes the user's communication style for personalization.", domain: "skills" },
  { id: "inviteInstructionGenerator", displayName: "Invite Instruction Generator", description: "Generates setup instructions for new skill invites.", domain: "skills" },
  { id: "skillCategoryInference", displayName: "Skill Category Inference", description: "Infers the category of a skill from its description.", domain: "skills" },
  { id: "meetConsentMonitor", displayName: "Meet Consent Monitor", description: "Monitors meeting consent signals during live calls.", domain: "skills" },
  { id: "meetChatOpportunity", displayName: "Meet Chat Opportunity", description: "Identifies opportunities to engage in meeting chat.", domain: "skills" },
  { id: "inference", displayName: "Inference", description: "General-purpose LLM inference call site for skill use.", domain: "skills" },
];

// Drift guard: verify catalog stays in sync with LLMCallSiteEnum.
const _validIds = new Set(LLMCallSiteEnum.options);
const _domainIds = new Set(CALL_SITE_DOMAINS.map((d) => d.id));
if (CALL_SITE_CATALOG.length !== LLMCallSiteEnum.options.length) {
  throw new Error(
    `CALL_SITE_CATALOG length (${CALL_SITE_CATALOG.length}) does not match LLMCallSiteEnum.options length (${LLMCallSiteEnum.options.length}). Update the catalog when adding or removing call sites.`,
  );
}
for (const entry of CALL_SITE_CATALOG) {
  if (!_validIds.has(entry.id as never)) {
    throw new Error(
      `CALL_SITE_CATALOG entry "${entry.id}" is not a member of LLMCallSiteEnum.`,
    );
  }
  if (!_domainIds.has(entry.domain)) {
    throw new Error(
      `CALL_SITE_CATALOG entry "${entry.id}" references unknown domain "${entry.domain}".`,
    );
  }
}
