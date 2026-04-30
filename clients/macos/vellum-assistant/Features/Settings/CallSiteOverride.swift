import Foundation
import VellumAssistantShared

/// A domain grouping for LLM call sites, fetched from the API catalog.
/// Replaces the former `CallSiteDomain` enum — domain metadata now lives
/// in the assistant runtime and is fetched once on sheet open.
public struct CallSiteDomain: Identifiable, Hashable {
    public let id: String
    public let displayName: String

    public init(id: String, displayName: String) {
        self.id = id
        self.displayName = displayName
    }
}

/// A user-editable override entry for a single LLM call site.
///
/// Mirrors the wire shape of `llm.callSites.<id>` in the assistant config:
/// any combination of `provider`, `model`, and `profile` may be set; an
/// entry where all three are `nil` represents "follows the default".
/// Display metadata (displayName, callSiteDescription, domain) comes from
/// the API catalog fetched by `CallSiteCatalog`.
public struct CallSiteOverride: Identifiable, Equatable, Hashable {
    /// Stable call-site identifier matching the backend `LLMCallSiteEnum`.
    public let id: String

    /// User-facing label shown in the override picker.
    public let displayName: String

    /// Short one-line description of what this call site does.
    public let callSiteDescription: String

    /// Domain ID matching a `CallSiteDomain.id` from the API catalog.
    public let domain: String

    /// Provider override; `nil` means "follows the default".
    public var provider: String?

    /// Model override; `nil` means "follows the default".
    public var model: String?

    /// Profile override referencing a key in `llm.profiles`; `nil` means
    /// "no profile selected".
    public var profile: String?

    public init(
        id: String,
        displayName: String,
        callSiteDescription: String = "",
        domain: String,
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

    /// True when this entry has at least one explicit override.
    public var hasOverride: Bool {
        provider != nil || model != nil || profile != nil
    }
}

/// Catalog of every LLM call site the assistant exposes.
///
/// Starts pre-seeded with the static catalog so the UI works before the
/// API fetch completes. `ensureLoaded(using:)` fetches from the assistant
/// runtime and replaces the seed data with the authoritative API response,
/// then sets `isLoaded = true`.
public final class CallSiteCatalog: ObservableObject {
    public static let shared = CallSiteCatalog()

    @Published public private(set) var domains: [CallSiteDomain] = CallSiteCatalog.staticDomains
    @Published public private(set) var callSites: [CallSiteOverride] = CallSiteCatalog.staticCallSites
    @Published public private(set) var isLoaded: Bool = false

    private var fetchTask: Task<Void, Never>?

    private init() {}

    /// Fetch the catalog from the assistant API if not already loaded.
    /// Safe to call multiple times — subsequent calls before the first
    /// fetch completes are no-ops.
    public func ensureLoaded(using client: SettingsClientProtocol = SettingsClient()) {
        guard !isLoaded, fetchTask == nil else { return }
        fetchTask = Task { @MainActor in
            if let response = await client.fetchCallSiteCatalog() {
                self.domains = response.domains.map { CallSiteDomain(id: $0.id, displayName: $0.displayName) }
                self.callSites = response.callSites.map {
                    CallSiteOverride(
                        id: $0.id,
                        displayName: $0.displayName,
                        callSiteDescription: $0.description,
                        domain: $0.domain
                    )
                }
                self.isLoaded = true
            }
            self.fetchTask = nil
        }
    }

    // MARK: - Computed accessors

    public var byId: [String: CallSiteOverride] {
        Dictionary(uniqueKeysWithValues: callSites.map { ($0.id, $0) })
    }

    public var validIds: Set<String> { Set(callSites.map(\.id)) }

    public func entries(for domain: CallSiteDomain) -> [CallSiteOverride] {
        callSites.filter { $0.domain == domain.id }
    }

    // MARK: - Backward compat static shims

    /// Returns the current catalog entries. Pre-seeded at startup so
    /// SettingsStore and tests have data immediately without an API fetch.
    public static var all: [CallSiteOverride] { shared.callSites }
    public static var byId: [String: CallSiteOverride] { shared.byId }
    public static var validIds: Set<String> { shared.validIds }

    // MARK: - Static seed (fallback / initial state)

    private static let staticDomains: [CallSiteDomain] = [
        CallSiteDomain(id: "agentLoop",     displayName: "Agent Loop"),
        CallSiteDomain(id: "memory",        displayName: "Memory"),
        CallSiteDomain(id: "workspace",     displayName: "Workspace"),
        CallSiteDomain(id: "ui",            displayName: "UI"),
        CallSiteDomain(id: "notifications", displayName: "Notifications"),
        CallSiteDomain(id: "skills",        displayName: "Skills"),
    ]

    private static let staticCallSites: [CallSiteOverride] = [
        // agentLoop
        CallSiteOverride(id: "mainAgent",         displayName: "Main Agent",         callSiteDescription: "The primary conversation agent that handles user messages.",             domain: "agentLoop"),
        CallSiteOverride(id: "subagentSpawn",     displayName: "Subagent Spawn",     callSiteDescription: "Spawns a subagent to handle a delegated subtask.",                      domain: "agentLoop"),
        CallSiteOverride(id: "heartbeatAgent",    displayName: "Heartbeat Agent",    callSiteDescription: "Runs background tasks and proactive checks on a schedule.",              domain: "agentLoop"),
        CallSiteOverride(id: "filingAgent",       displayName: "Filing Agent",       callSiteDescription: "Files memories and updates the knowledge base after conversations.",     domain: "agentLoop"),
        CallSiteOverride(id: "compactionAgent",   displayName: "Compaction Agent",   callSiteDescription: "Compacts conversation history to stay within context limits.",           domain: "agentLoop"),
        CallSiteOverride(id: "analyzeConversation", displayName: "Analyze Conversation", callSiteDescription: "Analyzes conversation content for summaries and insights.",          domain: "agentLoop"),
        CallSiteOverride(id: "callAgent",         displayName: "Call Agent",         callSiteDescription: "Handles voice call conversations.",                                      domain: "agentLoop"),
        // memory
        CallSiteOverride(id: "memoryExtraction",    displayName: "Memory Extraction",    callSiteDescription: "Extracts memorable facts from conversation turns.",                  domain: "memory"),
        CallSiteOverride(id: "memoryConsolidation", displayName: "Memory Consolidation", callSiteDescription: "Merges and deduplicates related memories.",                         domain: "memory"),
        CallSiteOverride(id: "memoryRetrieval",     displayName: "Memory Retrieval",     callSiteDescription: "Retrieves relevant memories to augment the agent context.",          domain: "memory"),
        CallSiteOverride(id: "memoryV2Migration",   displayName: "Memory V2 Migration",  callSiteDescription: "One-time migration of memories to the V2 storage format.",           domain: "memory"),
        CallSiteOverride(id: "memoryV2Sweep",       displayName: "Memory V2 Sweep",      callSiteDescription: "Background sweep pass for V2 memory maintenance.",                   domain: "memory"),
        CallSiteOverride(id: "recall",              displayName: "Recall",               callSiteDescription: "Searches memory to answer a specific question during a turn.",        domain: "memory"),
        CallSiteOverride(id: "narrativeRefinement", displayName: "Narrative Refinement", callSiteDescription: "Refines the autobiographical narrative stored in memory.",            domain: "memory"),
        CallSiteOverride(id: "patternScan",         displayName: "Pattern Scan",         callSiteDescription: "Scans memories for recurring behavioral patterns.",                   domain: "memory"),
        // workspace
        CallSiteOverride(id: "conversationSummarization", displayName: "Conversation Summarization", callSiteDescription: "Generates a summary of a completed conversation.",       domain: "workspace"),
        CallSiteOverride(id: "commitMessage",             displayName: "Commit Message",             callSiteDescription: "Generates a git commit message for staged changes.",      domain: "workspace"),
        // ui
        CallSiteOverride(id: "conversationStarters", displayName: "Conversation Starters", callSiteDescription: "Generates suggested conversation openers for the home screen.",   domain: "ui"),
        CallSiteOverride(id: "conversationTitle",    displayName: "Conversation Title",    callSiteDescription: "Generates a title for a conversation from its content.",           domain: "ui"),
        CallSiteOverride(id: "identityIntro",        displayName: "Identity Intro",        callSiteDescription: "Generates the assistant's introductory identity text.",            domain: "ui"),
        CallSiteOverride(id: "emptyStateGreeting",   displayName: "Empty State Greeting",  callSiteDescription: "Generates a greeting shown on the empty conversation screen.",     domain: "ui"),
        CallSiteOverride(id: "guardianQuestionCopy", displayName: "Guardian Question Copy", callSiteDescription: "Generates copy for guardian onboarding questions.",               domain: "ui"),
        CallSiteOverride(id: "approvalCopy",         displayName: "Approval Copy",         callSiteDescription: "Generates copy for tool approval prompts shown to the user.",      domain: "ui"),
        CallSiteOverride(id: "approvalConversation", displayName: "Approval Conversation", callSiteDescription: "Handles conversational approval flows.",                           domain: "ui"),
        CallSiteOverride(id: "feedEventCopy",        displayName: "Feed Event Copy",        callSiteDescription: "Generates copy for home feed event cards.",                        domain: "ui"),
        CallSiteOverride(id: "trustRuleSuggestion",  displayName: "Trust Rule Suggestion",  callSiteDescription: "Suggests a trust rule pattern when the user creates a new rule.",  domain: "ui"),
        // notifications
        CallSiteOverride(id: "notificationDecision",  displayName: "Notification Decision",  callSiteDescription: "Decides whether a background event warrants sending a notification.", domain: "notifications"),
        CallSiteOverride(id: "preferenceExtraction",  displayName: "Preference Extraction",  callSiteDescription: "Extracts notification and communication preferences from messages.",    domain: "notifications"),
        // skills
        CallSiteOverride(id: "interactionClassifier",      displayName: "Interaction Classifier",      callSiteDescription: "Classifies the type of interaction to route it correctly.",   domain: "skills"),
        CallSiteOverride(id: "styleAnalyzer",              displayName: "Style Analyzer",              callSiteDescription: "Analyzes the user's communication style for personalization.", domain: "skills"),
        CallSiteOverride(id: "inviteInstructionGenerator", displayName: "Invite Instruction Generator", callSiteDescription: "Generates setup instructions for new skill invites.",          domain: "skills"),
        CallSiteOverride(id: "skillCategoryInference",     displayName: "Skill Category Inference",    callSiteDescription: "Infers the category of a skill from its description.",         domain: "skills"),
        CallSiteOverride(id: "meetConsentMonitor",         displayName: "Meet Consent Monitor",        callSiteDescription: "Monitors meeting consent signals during live calls.",           domain: "skills"),
        CallSiteOverride(id: "meetChatOpportunity",        displayName: "Meet Chat Opportunity",        callSiteDescription: "Identifies opportunities to engage in meeting chat.",           domain: "skills"),
        CallSiteOverride(id: "inference",                  displayName: "Inference",                   callSiteDescription: "General-purpose LLM inference call site for skill use.",        domain: "skills"),
    ]
}
