import Foundation

enum ChatRole: String {
    case user
    case assistant
}

struct ChatMessage: Identifiable {
    let id: UUID
    let role: ChatRole
    var text: String
    let timestamp: Date
    var isStreaming: Bool
    var isQueued: Bool

    init(id: UUID = UUID(), role: ChatRole, text: String, timestamp: Date = Date(), isStreaming: Bool = false, isQueued: Bool = false) {
        self.id = id
        self.role = role
        self.text = text
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.isQueued = isQueued
    }
}
