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

    init(id: UUID = UUID(), role: ChatRole, text: String, timestamp: Date = Date(), isStreaming: Bool = false) {
        self.id = id
        self.role = role
        self.text = text
        self.timestamp = timestamp
        self.isStreaming = isStreaming
    }
}
