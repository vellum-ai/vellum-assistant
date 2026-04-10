/// Structured context from the native pre-chat onboarding flow.
/// Serialized to JSON and sent with the first message so the assistant
/// can personalize its opener.
public struct PreChatOnboardingContext: Codable, Sendable {
    public let tools: [String]       // e.g. ["slack", "linear", "figma"]
    public let tasks: [String]       // e.g. ["code-building", "writing"]
    public let tone: String          // "casual", "professional", or "balanced"
    public let userName: String?     // nil if skipped
    public let assistantName: String? // nil if kept default

    public init(tools: [String], tasks: [String], tone: String,
                userName: String?, assistantName: String?) {
        self.tools = tools
        self.tasks = tasks
        self.tone = tone
        self.userName = userName
        self.assistantName = assistantName
    }
}
