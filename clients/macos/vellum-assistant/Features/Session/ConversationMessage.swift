import Foundation

struct ConversationMessage: Identifiable {
    enum Role {
        case user
        case assistant
    }
    let id: UUID
    let role: Role
    let text: String
    let timestamp: Date

    init(role: Role, text: String, timestamp: Date = Date()) {
        self.id = UUID()
        self.role = role
        self.text = text
        self.timestamp = timestamp
    }
}
