import Foundation

enum ChatRole: String {
    case user
    case assistant
}

enum ChatMessageStatus: Equatable {
    case sent
    case queued(position: Int)
    case processing
}

struct ChatMessage: Identifiable {
    let id: UUID
    let role: ChatRole
    var text: String
    let timestamp: Date
    var isStreaming: Bool
    var status: ChatMessageStatus

    init(id: UUID = UUID(), role: ChatRole, text: String, timestamp: Date = Date(), isStreaming: Bool = false, status: ChatMessageStatus = .sent) {
        self.id = id
        self.role = role
        self.text = text
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.status = status
    }
}
