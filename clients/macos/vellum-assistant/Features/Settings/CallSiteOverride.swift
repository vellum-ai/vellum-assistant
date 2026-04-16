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
    /// (e.g. `"Memory · Retrieval"`).
    public let displayName: String

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
        domain: CallSiteDomain,
        provider: String? = nil,
        model: String? = nil,
        profile: String? = nil
    ) {
        self.id = id
        self.displayName = displayName
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
        CallSiteOverride(id: "mainAgent", displayName: "Main agent", domain: .agentLoop),
        CallSiteOverride(id: "subagentSpawn", displayName: "Subagent spawn", domain: .agentLoop),
        CallSiteOverride(id: "heartbeatAgent", displayName: "Heartbeat agent", domain: .agentLoop),
        CallSiteOverride(id: "filingAgent", displayName: "Filing agent", domain: .agentLoop),
        CallSiteOverride(id: "analyzeConversation", displayName: "Analyze conversation", domain: .agentLoop),
        CallSiteOverride(id: "callAgent", displayName: "Call agent", domain: .agentLoop),
        // Memory
        CallSiteOverride(id: "memoryExtraction", displayName: "Memory · Extraction", domain: .memory),
        CallSiteOverride(id: "memoryConsolidation", displayName: "Memory · Consolidation", domain: .memory),
        CallSiteOverride(id: "memoryRetrieval", displayName: "Memory · Retrieval", domain: .memory),
        CallSiteOverride(id: "narrativeRefinement", displayName: "Narrative refinement", domain: .memory),
        CallSiteOverride(id: "patternScan", displayName: "Pattern scan", domain: .memory),
        CallSiteOverride(id: "conversationSummarization", displayName: "Conversation summarization", domain: .memory),
        CallSiteOverride(id: "conversationStarters", displayName: "Conversation starters", domain: .memory),
        // Workspace
        CallSiteOverride(id: "conversationTitle", displayName: "Conversation title", domain: .workspace),
        CallSiteOverride(id: "commitMessage", displayName: "Commit message generator", domain: .workspace),
        // UI
        CallSiteOverride(id: "identityIntro", displayName: "Identity intro", domain: .ui),
        CallSiteOverride(id: "emptyStateGreeting", displayName: "Empty-state greeting", domain: .ui),
        // Notifications
        CallSiteOverride(id: "notificationDecision", displayName: "Notification decision", domain: .notifications),
        CallSiteOverride(id: "preferenceExtraction", displayName: "Preference extraction", domain: .notifications),
        // Voice
        CallSiteOverride(id: "guardianQuestionCopy", displayName: "Guardian question copy", domain: .voice),
        CallSiteOverride(id: "watchCommentary", displayName: "Watch commentary", domain: .voice),
        CallSiteOverride(id: "watchSummary", displayName: "Watch summary", domain: .voice),
        // Utility
        CallSiteOverride(id: "interactionClassifier", displayName: "Interaction classifier", domain: .utility),
        CallSiteOverride(id: "styleAnalyzer", displayName: "Style analyzer", domain: .utility),
        CallSiteOverride(id: "inviteInstructionGenerator", displayName: "Invite instruction generator", domain: .utility),
        CallSiteOverride(id: "skillCategoryInference", displayName: "Skill category inference", domain: .utility),
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
