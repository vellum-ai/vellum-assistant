import Foundation

/// Logical grouping for an LLM call site, used to organize the per-call-site
/// overrides view introduced in PRs 22-24.
///
/// Mirrors the structure documented in the unify-llm-callsites plan: each
/// call-site ID belongs to exactly one domain so the UI can render them in
/// a stable, user-friendly order.
public enum CallSiteDomain: String, CaseIterable, Identifiable, Hashable {
    case agentLoop
    case memory
    case workspace
    case ui
    case notifications
    case voice
    case utility
    case skills

    public var id: String { rawValue }

    /// User-facing label for this domain. Shown as a section header in the
    /// per-call-site override picker.
    public var displayName: String {
        switch self {
        case .agentLoop: return "Agent loop"
        case .memory: return "Memory"
        case .workspace: return "Workspace"
        case .ui: return "UI"
        case .notifications: return "Notifications"
        case .voice: return "Voice"
        case .utility: return "Utility"
        case .skills: return "Skills"
        }
    }

    /// Stable display order for sections in the override picker. Lower values
    /// appear first.
    public var sortOrder: Int {
        switch self {
        case .agentLoop: return 0
        case .memory: return 1
        case .workspace: return 2
        case .ui: return 3
        case .notifications: return 4
        case .voice: return 5
        case .utility: return 6
        case .skills: return 7
        }
    }
}

/// A user-editable override entry for a single LLM call site.
///
/// Mirrors the wire shape of `llm.callSites.<id>` in the assistant config:
/// any combination of `provider`, `model`, and `profile` may be set; an
/// entry where all three are `nil` represents "follows the default".
public struct CallSiteOverride: Identifiable, Equatable, Hashable {
    /// Stable call-site identifier matching the backend `LLMCallSiteEnum`
    /// (e.g. `"memoryRetrieval"`).
    public let id: String

    /// User-facing label shown in the override picker
    /// (e.g. `"Memory retrieval"`).
    public let displayName: String

    /// Short one-line description of what this call site does.
    public let callSiteDescription: String

    /// Logical grouping for sectioning in the picker.
    public let domain: CallSiteDomain

    /// Provider override; `nil` means "follows the default".
    public var provider: String?

    /// Model override; `nil` means "follows the default" (or the profile,
    /// when one is selected).
    public var model: String?

    /// Profile override referencing a key in `llm.profiles`; `nil` means
    /// "no profile selected".
    public var profile: String?

    public init(
        id: String,
        displayName: String,
        callSiteDescription: String = "",
        domain: CallSiteDomain,
        provider: String? = nil,
        model: String? = nil,
        profile: String? = nil
    ) {
        self.id = id
        self.displayName = displayName
        self.callSiteDescription = callSiteDescription
        self.domain = domain
        self.provider = provider
        self.model = model
        self.profile = profile
    }

    /// True when this entry has at least one explicit override
    /// (`provider`, `model`, or `profile`).
    public var hasOverride: Bool {
        provider != nil || model != nil || profile != nil
    }
}

/// Static catalog of every call site the assistant exposes.
///
/// Mirrors the backend `LLMCallSiteEnum` in
/// `assistant/src/config/schemas/llm.ts`. When the backend enum changes,
/// update this catalog in lockstep so the macOS UI can render every site
/// without depending on a runtime fetch.
public enum CallSiteCatalog {
    /// All known call sites, paired with their display name and domain.
    /// Order matches the backend enum so the UI is deterministic.
    public static let all: [CallSiteOverride] = [
        // Agent loop
        CallSiteOverride(id: "mainAgent", displayName: "Main agent", callSiteDescription: "Primary conversational reasoning", domain: .agentLoop),
        CallSiteOverride(id: "subagentSpawn", displayName: "Subagent spawn", callSiteDescription: "Parallel task execution", domain: .agentLoop),
        CallSiteOverride(id: "heartbeatAgent", displayName: "Heartbeat agent", callSiteDescription: "Background monitoring and check-ins", domain: .agentLoop),
        CallSiteOverride(id: "filingAgent", displayName: "Filing agent", callSiteDescription: "Organizes and files conversation content", domain: .agentLoop),
        CallSiteOverride(id: "compactionAgent", displayName: "Context compactor", callSiteDescription: "Compresses conversation context", domain: .agentLoop),
        CallSiteOverride(id: "analyzeConversation", displayName: "Analyze conversation", callSiteDescription: "Reviews conversation for insights", domain: .agentLoop),
        CallSiteOverride(id: "callAgent", displayName: "Call agent", callSiteDescription: "Handles voice call interactions", domain: .agentLoop),
        // Memory
        CallSiteOverride(id: "memoryExtraction", displayName: "Memory extraction", callSiteDescription: "Extracts facts from conversations", domain: .memory),
        CallSiteOverride(id: "memoryConsolidation", displayName: "Memory consolidation", callSiteDescription: "Merges and deduplicates memories", domain: .memory),
        CallSiteOverride(id: "memoryRetrieval", displayName: "Memory retrieval", callSiteDescription: "Recalls relevant memories", domain: .memory),
        CallSiteOverride(id: "memoryV2Migration", displayName: "Memory migration", callSiteDescription: "Migrates memories to new format", domain: .memory),
        CallSiteOverride(id: "memoryV2Sweep", displayName: "Memory sweep", callSiteDescription: "Cleans up stale memory entries", domain: .memory),
        CallSiteOverride(id: "recall", displayName: "Recall", callSiteDescription: "Retrieves contextual memories", domain: .memory),
        CallSiteOverride(id: "narrativeRefinement", displayName: "Narrative refinement", callSiteDescription: "Refines personal narrative summaries", domain: .memory),
        CallSiteOverride(id: "patternScan", displayName: "Pattern scan", callSiteDescription: "Detects recurring patterns and habits", domain: .memory),
        CallSiteOverride(id: "conversationSummarization", displayName: "Conversation summarization", callSiteDescription: "Summarizes past conversations", domain: .memory),
        CallSiteOverride(id: "conversationStarters", displayName: "Conversation starters", callSiteDescription: "Suggests topics to talk about", domain: .memory),
        // Workspace
        CallSiteOverride(id: "conversationTitle", displayName: "Conversation title", callSiteDescription: "Generates conversation titles", domain: .workspace),
        CallSiteOverride(id: "commitMessage", displayName: "Commit message", callSiteDescription: "Writes git commit messages", domain: .workspace),
        // UI
        CallSiteOverride(id: "identityIntro", displayName: "Identity intro", callSiteDescription: "Crafts the assistant's introduction", domain: .ui),
        CallSiteOverride(id: "emptyStateGreeting", displayName: "Empty-state greeting", callSiteDescription: "Greeting shown on new conversations", domain: .ui),
        // Notifications
        CallSiteOverride(id: "notificationDecision", displayName: "Notification decision", callSiteDescription: "Decides whether to send a notification", domain: .notifications),
        CallSiteOverride(id: "preferenceExtraction", displayName: "Preference extraction", callSiteDescription: "Learns notification preferences", domain: .notifications),
        // Voice
        CallSiteOverride(id: "guardianQuestionCopy", displayName: "Guardian question copy", callSiteDescription: "Generates guardian verification prompts", domain: .voice),
        // Utility
        CallSiteOverride(id: "approvalCopy", displayName: "Approval copy", callSiteDescription: "Generates approval request text", domain: .utility),
        CallSiteOverride(id: "approvalConversation", displayName: "Approval conversation", callSiteDescription: "Handles approval conversations", domain: .utility),
        CallSiteOverride(id: "interactionClassifier", displayName: "Interaction classifier", callSiteDescription: "Classifies the type of interaction", domain: .utility),
        CallSiteOverride(id: "styleAnalyzer", displayName: "Style analyzer", callSiteDescription: "Analyzes communication style", domain: .utility),
        CallSiteOverride(id: "inviteInstructionGenerator", displayName: "Invite instruction generator", callSiteDescription: "Creates invite setup instructions", domain: .utility),
        CallSiteOverride(id: "skillCategoryInference", displayName: "Skill category inference", callSiteDescription: "Categorizes installed skills", domain: .utility),
        CallSiteOverride(id: "inference", displayName: "Inference", callSiteDescription: "General-purpose inference", domain: .utility),
        CallSiteOverride(id: "feedEventCopy", displayName: "Feed event copy", callSiteDescription: "Generates feed event text", domain: .utility),
        CallSiteOverride(id: "trustRuleSuggestion", displayName: "Trust rule suggestion", callSiteDescription: "Suggests trust rules", domain: .utility),
        // Skills
        CallSiteOverride(id: "meetConsentMonitor", displayName: "Meet consent monitor", callSiteDescription: "Monitors meeting consent status", domain: .skills),
        CallSiteOverride(id: "meetChatOpportunity", displayName: "Meet chat opportunity", callSiteDescription: "Detects chances to contribute in meetings", domain: .skills),
    ]

    /// Lookup table from call-site ID to its catalog entry. Constructed
    /// once at first access for O(1) lookup during config sync.
    public static let byId: [String: CallSiteOverride] = {
        Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })
    }()

    /// Set of valid call-site IDs, used to validate / filter raw config
    /// payloads coming back from the daemon.
    public static let validIds: Set<String> = Set(all.map { $0.id })
}
