/// Structured context from the native pre-chat onboarding flow.
/// Serialized to JSON and sent with the first message so the assistant
/// can personalize its opener.
public struct PreChatOnboardingContext: Codable, Sendable {
    public static let defaultInitialMessage = "Wake up, my friend!"

    private enum CodingKeys: String, CodingKey {
        case tools
        case tasks
        case tone
        case userName
        case assistantName
        case cohort
        case bootstrapTemplate
        case initialMessage
        case skills
    }

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

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(tools, forKey: .tools)
        try container.encode(tasks, forKey: .tasks)
        try container.encode(tone, forKey: .tone)
        try container.encodeIfPresent(userName, forKey: .userName)
        try container.encodeIfPresent(assistantName, forKey: .assistantName)
        try container.encodeIfPresent(cohort, forKey: .cohort)
        try container.encodeIfPresent(bootstrapTemplate, forKey: .bootstrapTemplate)
        if let initialMessage,
           initialMessage.trimmingCharacters(in: .whitespacesAndNewlines) != Self.defaultInitialMessage {
            try container.encode(initialMessage, forKey: .initialMessage)
        }
        try container.encodeIfPresent(skills, forKey: .skills)
    }

    public static func buildInitialMessage(userName: String?, assistantName: String?) -> String {
        let assistant = assistantName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let user = userName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedAssistant = assistant?.isEmpty == false ? assistant : nil
        let resolvedUser = user?.isEmpty == false ? user : nil
        if resolvedAssistant == nil && resolvedUser == nil {
            return defaultInitialMessage
        }
        let hi = resolvedAssistant.map { "Hi \($0)" } ?? "Hi"
        let intro = resolvedUser.map { ", I'm \($0)" } ?? ""
        return "\(hi)\(intro). Nice to meet you."
    }
}
