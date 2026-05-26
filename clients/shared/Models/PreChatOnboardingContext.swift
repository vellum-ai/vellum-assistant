/// Structured context from the native pre-chat onboarding flow.
/// Serialized to JSON and sent with the first message so the assistant
/// can personalize its opener.
public struct PreChatOnboardingContext: Codable, Sendable {
    public let tools: [String]              // e.g. ["slack", "linear", "figma"]
    public let tasks: [String]              // e.g. ["code-building", "writing"]
    public let tone: String                 // "grounded", "warm", "energetic", or "poetic"
    public let userName: String?            // nil if skipped
    public let assistantName: String?       // nil if kept default
    public let cohort: String?              // onboarding cohort identifier
    public let bootstrapTemplate: String?   // recipe template slug for initial setup
    public let initialMessage: String?      // pre-filled first message from the recipe
    public let skills: [String]?            // skill slugs to activate for the recipe

    public init(tools: [String], tasks: [String], tone: String,
                userName: String?, assistantName: String?,
                cohort: String? = nil,
                bootstrapTemplate: String? = nil,
                initialMessage: String? = nil,
                skills: [String]? = nil) {
        self.tools = tools
        self.tasks = tasks
        self.tone = tone
        self.userName = userName
        self.assistantName = assistantName
        self.cohort = cohort
        self.bootstrapTemplate = bootstrapTemplate
        self.initialMessage = initialMessage
        self.skills = skills
    }
}
