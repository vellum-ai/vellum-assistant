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

/// Tracks the state of an inline tool confirmation request.
enum ToolConfirmationState: Equatable {
    case pending
    case approved
    case denied
    case timedOut
}

/// Data for an inline tool confirmation message displayed in chat.
struct ToolConfirmationData: Equatable {
    let requestId: String
    let toolName: String
    let riskLevel: String
    let diff: ConfirmationRequestMessage.ConfirmationDiffInfo?
    var state: ToolConfirmationState = .pending
}

/// A file or image attachment associated with a chat message.
struct ChatAttachment: Identifiable {
    let id: String
    let filename: String
    let mimeType: String
    /// Base64-encoded file data.
    let data: String
    /// Pre-rendered thumbnail for image attachments (resized to 120px max dimension).
    let thumbnailData: Data?
}

struct ChatMessage: Identifiable {
    let id: UUID
    let role: ChatRole
    var text: String
    let timestamp: Date
    var isStreaming: Bool
    var status: ChatMessageStatus
    /// Non-nil when this message is an inline tool confirmation request.
    var confirmation: ToolConfirmationData?
    var attachments: [ChatAttachment]

    init(id: UUID = UUID(), role: ChatRole, text: String, timestamp: Date = Date(), isStreaming: Bool = false, status: ChatMessageStatus = .sent, confirmation: ToolConfirmationData? = nil, attachments: [ChatAttachment] = []) {
        self.id = id
        self.role = role
        self.text = text
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.status = status
        self.confirmation = confirmation
        self.attachments = attachments
    }
}
