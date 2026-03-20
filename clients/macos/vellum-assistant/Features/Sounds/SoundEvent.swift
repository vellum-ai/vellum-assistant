import Foundation

/// Represents the distinct sound events that can be configured and triggered throughout the app.
enum SoundEvent: String, CaseIterable, Codable {
    case appOpen = "app_open"
    case taskComplete = "task_complete"
    case needsInput = "needs_input"
    case taskFailed = "task_failed"
    case notification = "notification"
    case newConversation = "new_conversation"
    case messageSent = "message_sent"
    case characterPoke = "character_poke"
    case random = "random"

    /// Human-readable label for display in the Settings UI.
    var displayName: String {
        switch self {
        case .appOpen: return "App Open"
        case .taskComplete: return "Task Complete"
        case .needsInput: return "Needs Input"
        case .taskFailed: return "Task Failed"
        case .notification: return "Notification"
        case .newConversation: return "New Conversation"
        case .messageSent: return "Message Sent"
        case .characterPoke: return "Character Poke"
        case .random: return "Random"
        }
    }
}
