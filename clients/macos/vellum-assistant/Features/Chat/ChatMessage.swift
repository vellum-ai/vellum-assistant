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
    let input: [String: AnyCodable]
    let riskLevel: String
    let diff: ConfirmationRequestMessage.ConfirmationDiffInfo?
    let allowlistOptions: [ConfirmationRequestMessage.ConfirmationAllowlistOption]
    let scopeOptions: [ConfirmationRequestMessage.ConfirmationScopeOption]
    var state: ToolConfirmationState = .pending

    /// Human-readable preview of the tool input (e.g. the bash command or file path).
    var commandPreview: String {
        switch toolName {
        case "bash":
            return (input["command"]?.value as? String) ?? ""
        case "file_read":
            return "read \((input["path"]?.value as? String) ?? "")"
        case "file_write":
            return "write \((input["path"]?.value as? String) ?? "")"
        case "file_edit":
            return "edit \((input["path"]?.value as? String) ?? "")"
        case "web_fetch":
            return "fetch \((input["url"]?.value as? String) ?? "")"
        case "browser_navigate":
            return "navigate \((input["url"]?.value as? String) ?? "")"
        default:
            // Fallback: show first string value or tool name
            if let firstString = input.values.compactMap({ $0.value as? String }).first {
                return firstString
            }
            return ""
        }
    }

    init(requestId: String, toolName: String, input: [String: AnyCodable] = [:], riskLevel: String, diff: ConfirmationRequestMessage.ConfirmationDiffInfo? = nil, allowlistOptions: [ConfirmationRequestMessage.ConfirmationAllowlistOption] = [], scopeOptions: [ConfirmationRequestMessage.ConfirmationScopeOption] = [], state: ToolConfirmationState = .pending) {
        self.requestId = requestId
        self.toolName = toolName
        self.input = input
        self.riskLevel = riskLevel
        self.diff = diff
        self.allowlistOptions = allowlistOptions
        self.scopeOptions = scopeOptions
        self.state = state
    }
}

/// Data for a tool call displayed inline in an assistant message.
struct ToolCallData: Identifiable, Equatable {
    let id: UUID
    let toolName: String
    let inputSummary: String
    var result: String?
    var isError: Bool
    var isComplete: Bool

    init(id: UUID = UUID(), toolName: String, inputSummary: String, result: String? = nil, isError: Bool = false, isComplete: Bool = false) {
        self.id = id
        self.toolName = toolName
        self.inputSummary = inputSummary
        self.result = result
        self.isError = isError
        self.isComplete = isComplete
    }
}

/// Data for an inline UI surface rendered within a chat message.
struct InlineSurfaceData: Identifiable, Equatable {
    let id: String
    let surfaceType: SurfaceType
    let title: String?
    let data: SurfaceData
    let actions: [SurfaceActionButton]

    static func == (lhs: InlineSurfaceData, rhs: InlineSurfaceData) -> Bool {
        lhs.id == rhs.id
    }
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
    var toolCalls: [ToolCallData]
    var inlineSurfaces: [InlineSurfaceData]

    init(id: UUID = UUID(), role: ChatRole, text: String, timestamp: Date = Date(), isStreaming: Bool = false, status: ChatMessageStatus = .sent, confirmation: ToolConfirmationData? = nil, attachments: [ChatAttachment] = [], toolCalls: [ToolCallData] = [], inlineSurfaces: [InlineSurfaceData] = []) {
        self.id = id
        self.role = role
        self.text = text
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.status = status
        self.confirmation = confirmation
        self.attachments = attachments
        self.toolCalls = toolCalls
        self.inlineSurfaces = inlineSurfaces
    }
}
