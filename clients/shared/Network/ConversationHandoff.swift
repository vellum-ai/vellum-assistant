import Foundation

/// Shared default conversation key used to continue a local first-party session
/// across desktop/browser/mobile interfaces when a caller does not provide a
/// specific conversation key.
public enum ConversationHandoff {
    public static let defaultLocalConversationKey = "default:vellum:handoff"

    public static func normalizeConversationKey(_ value: String?) -> String {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return defaultLocalConversationKey
        }
        return trimmed
    }
}
