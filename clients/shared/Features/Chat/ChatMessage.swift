import Foundation
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#else
#error("Unsupported platform")
#endif

public enum ChatRole: String {
    case user
    case assistant
}

public enum ChatMessageStatus: Equatable {
    case sent
    case queued(position: Int)
    case processing
}

/// Tracks the state of an inline tool confirmation request.
public enum ToolConfirmationState: Equatable {
    case pending
    case approved
    case denied
    case timedOut
}

/// Data for an inline tool confirmation message displayed in chat.
public struct ToolConfirmationData: Equatable {
    public let requestId: String
    public let toolName: String
    public let input: [String: AnyCodable]
    public let riskLevel: String
    public let diff: ConfirmationRequestMessage.ConfirmationDiffInfo?
    public let allowlistOptions: [ConfirmationRequestMessage.ConfirmationAllowlistOption]
    public let scopeOptions: [ConfirmationRequestMessage.ConfirmationScopeOption]
    public let executionTarget: String?
    public var state: ToolConfirmationState = .pending

    /// Normalized target label shown in confirmation UIs.
    public var normalizedExecutionTarget: String? {
        guard let executionTarget else { return nil }
        let normalized = executionTarget.lowercased()
        guard normalized == "host" || normalized == "sandbox" else { return nil }
        return normalized
    }

    /// Short third-person summary shown above the code snippet in the details disclosure.
    public var detailsSummary: String {
        switch toolName {
        case "bash", "host_bash":
            return "The assistant wants to run a command"
        case "file_write", "host_file_write":
            let path = (input["path"]?.value as? String) ?? ""
            if path.isEmpty { return "The assistant wants to write a file" }
            let name = URL(fileURLWithPath: path).lastPathComponent
            return "The assistant wants to write to \(name)"
        case "file_edit", "host_file_edit":
            let path = (input["path"]?.value as? String) ?? ""
            if path.isEmpty { return "The assistant wants to edit a file" }
            let name = URL(fileURLWithPath: path).lastPathComponent
            return "The assistant wants to edit \(name)"
        case "file_read", "host_file_read":
            let path = (input["path"]?.value as? String) ?? ""
            if path.isEmpty { return "The assistant wants to read a file" }
            let name = URL(fileURLWithPath: path).lastPathComponent
            return "The assistant wants to read \(name)"
        case "web_fetch":
            let url = (input["url"]?.value as? String) ?? ""
            if let host = URL(string: url)?.host {
                return "The assistant wants to fetch data from \(host)"
            }
            return "The assistant wants to fetch a URL"
        case "browser_navigate":
            let url = (input["url"]?.value as? String) ?? ""
            if let host = URL(string: url)?.host {
                return "The assistant wants to open \(host)"
            }
            return "The assistant wants to open a page"
        default:
            return "The assistant wants to use \(toolName)"
        }
    }

    /// Human-readable preview of the tool input (e.g. the bash command or file path).
    public var commandPreview: String {
        switch toolName {
        case "bash", "host_bash":
            return (input["command"]?.value as? String) ?? ""
        case "file_read", "host_file_read":
            return "read \((input["path"]?.value as? String) ?? "")"
        case "file_write", "host_file_write":
            return "write \((input["path"]?.value as? String) ?? "")"
        case "file_edit", "host_file_edit":
            return "edit \((input["path"]?.value as? String) ?? "")"
        case "web_fetch":
            return "fetch \((input["url"]?.value as? String) ?? "")"
        case "browser_navigate":
            return "navigate \((input["url"]?.value as? String) ?? "")"
        case "request_system_permission":
            return (input["permission_type"]?.value as? String) ?? "system permission"
        default:
            // Fallback: show first string value or tool name
            if let firstString = input.values.compactMap({ $0.value as? String }).first {
                return firstString
            }
            return ""
        }
    }

    /// User-facing tool category label (e.g. "Run Command", "Write File").
    public var toolCategory: String {
        switch toolName {
        case "bash", "host_bash":          return "Run Command"
        case "file_write", "host_file_write": return "Write File"
        case "file_edit", "host_file_edit":   return "Edit File"
        case "file_read", "host_file_read":   return "Read File"
        case "web_fetch":                     return "Fetch URL"
        case "browser_navigate":              return "Open Page"
        default:
            return toolName
                .replacingOccurrences(of: "_", with: " ")
                .split(separator: " ")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    /// SF Symbol name for the tool category.
    public var toolCategoryIcon: String {
        switch toolName {
        case "bash", "host_bash":              return "terminal"
        case "file_write", "host_file_write":  return "doc.badge.plus"
        case "file_edit", "host_file_edit":    return "pencil.line"
        case "file_read", "host_file_read":    return "doc.text"
        case "web_fetch":                      return "arrow.down.circle"
        case "browser_navigate":               return "globe"
        default:                               return "puzzlepiece.extension"
        }
    }

    /// Whether a diff is available for display.
    public var hasDiff: Bool { diff != nil }

    /// Whether this is a system permission request (TCC).
    public var isSystemPermissionRequest: Bool {
        toolName == "request_system_permission"
    }

    /// The permission type for system permission requests.
    public var permissionType: String? {
        guard isSystemPermissionRequest else { return nil }
        return input["permission_type"]?.value as? String
    }

    /// Friendly display name for the permission type.
    public var permissionFriendlyName: String {
        guard let type = permissionType else { return "Permission" }
        switch type {
        case "full_disk_access": return "Full Disk Access"
        case "accessibility": return "Accessibility"
        case "screen_recording": return "Screen Recording"
        case "calendar": return "Calendar"
        case "contacts": return "Contacts"
        case "photos": return "Photos"
        case "location": return "Location Services"
        case "microphone": return "Microphone"
        case "camera": return "Camera"
        default: return type.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    /// The macOS System Settings deep-link URL for the permission.
    public var settingsURL: URL? {
        guard let type = permissionType else { return nil }
        let urlString: String
        switch type {
        case "full_disk_access":
            urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
        case "accessibility":
            urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        case "screen_recording":
            urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        case "calendar":
            urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"
        case "contacts":
            urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts"
        case "photos":
            urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_Photos"
        case "location":
            urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices"
        case "microphone":
            urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        case "camera":
            urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"
        default:
            urlString = "x-apple.systempreferences:com.apple.preference.security"
        }
        return URL(string: urlString)
    }

    /// Short, personable description of the action being requested.
    public var humanDescription: String {
        let reason = (input["reason"]?.value as? String) ?? ""
        // Lowercase the first letter so reason flows naturally mid-sentence (e.g. "to determine..." not "To determine...")
        let r = reason.isEmpty ? "" : reason.prefix(1).lowercased() + reason.dropFirst()

        switch toolName {
        case "request_system_permission":
            if reason.isEmpty {
                return "I need \(permissionFriendlyName) access to continue."
            }
            return reason
        case "bash", "host_bash":
            if !r.isEmpty { return "I would like to run a shell command \(r)." }
            return "I would like to run a shell command."
        case "file_write", "host_file_write":
            if !r.isEmpty { return "I would like to write a file \(r)." }
            let path = (input["path"]?.value as? String) ?? ""
            if path.isEmpty { return "I would like to write a file." }
            return "I would like to write to \(URL(fileURLWithPath: path).lastPathComponent)."
        case "file_edit", "host_file_edit":
            if !r.isEmpty { return "I would like to edit a file \(r)." }
            let path = (input["path"]?.value as? String) ?? ""
            if path.isEmpty { return "I would like to edit a file." }
            return "I would like to edit \(URL(fileURLWithPath: path).lastPathComponent)."
        case "file_read", "host_file_read":
            if !r.isEmpty { return "I would like to read a file \(r)." }
            let path = (input["path"]?.value as? String) ?? ""
            if path.isEmpty { return "I would like to read a file." }
            return "I would like to read \(URL(fileURLWithPath: path).lastPathComponent)."
        case "web_fetch":
            if !r.isEmpty { return "I would like to fetch a URL \(r)." }
            let url = (input["url"]?.value as? String) ?? ""
            if let host = URL(string: url)?.host {
                return "I would like to fetch data from \(host)."
            }
            return "I would like to fetch a URL."
        case "browser_navigate":
            let url = (input["url"]?.value as? String) ?? ""
            if let host = URL(string: url)?.host {
                return "I would like to open \(host)."
            }
            return "I would like to open a page."
        default:
            return "I would like to use \(toolCategory)."
        }
    }

    public init(requestId: String, toolName: String, input: [String: AnyCodable] = [:], riskLevel: String, diff: ConfirmationRequestMessage.ConfirmationDiffInfo? = nil, allowlistOptions: [ConfirmationRequestMessage.ConfirmationAllowlistOption] = [], scopeOptions: [ConfirmationRequestMessage.ConfirmationScopeOption] = [], executionTarget: String? = nil, state: ToolConfirmationState = .pending) {
        self.requestId = requestId
        self.toolName = toolName
        self.input = input
        self.riskLevel = riskLevel
        self.diff = diff
        self.allowlistOptions = allowlistOptions
        self.scopeOptions = scopeOptions
        self.executionTarget = executionTarget
        self.state = state
    }
}

/// Data for a tool call displayed inline in an assistant message.
public struct ToolCallData: Identifiable, Equatable {
    public let id: UUID
    public let toolName: String
    public let inputSummary: String
    public var result: String?
    public var isError: Bool
    public var isComplete: Bool
    /// Whether this tool call arrived before any text content in the message.
    /// Used to render pre-text tool calls above and post-text tool calls below the bubble.
    public var arrivedBeforeText: Bool
    public var startedAt: Date?
    public var completedAt: Date?
    /// Base64-encoded image data from tool contentBlocks (e.g. browser_screenshot).
    public var imageData: String?
    /// Pre-decoded NSImage cached to avoid repeated base64 decoding in SwiftUI body.
    #if os(macOS)
    public var cachedImage: NSImage?
    #elseif os(iOS)
    public var cachedImage: UIImage?
    #else
    #error("Unsupported platform")
    #endif

    public static func == (lhs: ToolCallData, rhs: ToolCallData) -> Bool {
        lhs.id == rhs.id
            && lhs.toolName == rhs.toolName
            && lhs.inputSummary == rhs.inputSummary
            && lhs.result == rhs.result
            && lhs.isError == rhs.isError
            && lhs.isComplete == rhs.isComplete
            && lhs.arrivedBeforeText == rhs.arrivedBeforeText
            && lhs.imageData == rhs.imageData
    }

    public init(id: UUID = UUID(), toolName: String, inputSummary: String, result: String? = nil, isError: Bool = false, isComplete: Bool = false, arrivedBeforeText: Bool = true, imageData: String? = nil, startedAt: Date? = nil, completedAt: Date? = nil) {
        self.id = id
        self.toolName = toolName
        self.inputSummary = inputSummary
        self.result = result
        self.isError = isError
        self.isComplete = isComplete
        self.arrivedBeforeText = arrivedBeforeText
        self.imageData = imageData
        self.cachedImage = Self.decodeImage(from: imageData)
        self.startedAt = startedAt
        self.completedAt = completedAt
    }

    /// Decode base64 image data into a platform image. Returns nil if data is absent or invalid.
    #if os(macOS)
    public static func decodeImage(from base64String: String?) -> NSImage? {
        guard let base64String, let data = Data(base64Encoded: base64String) else { return nil }
        return NSImage(data: data)
    }
    #elseif os(iOS)
    public static func decodeImage(from base64String: String?) -> UIImage? {
        guard let base64String, let data = Data(base64Encoded: base64String) else { return nil }
        return UIImage(data: data)
    }
    #else
    #error("Unsupported platform")
    #endif
}

/// Data for an inline UI surface rendered within a chat message.
public struct InlineSurfaceData: Identifiable, Equatable {
    public let id: String
    public let surfaceType: SurfaceType
    public let title: String?
    public let data: SurfaceData
    public let actions: [SurfaceActionButton]
    /// Original IPC message for dynamic pages, used to re-open the workspace.
    public let surfaceMessage: UiSurfaceShowMessage?

    public static func == (lhs: InlineSurfaceData, rhs: InlineSurfaceData) -> Bool {
        lhs.id == rhs.id
            && lhs.completionState == rhs.completionState
            && lhs.surfaceType == rhs.surfaceType
            && lhs.title == rhs.title
            && lhs.actions == rhs.actions
    }

    /// When non-nil, the surface has been completed and should render in collapsed/chip state.
    public var completionState: SurfaceCompletionState?

    public init(id: String, surfaceType: SurfaceType, title: String?, data: SurfaceData, actions: [SurfaceActionButton], surfaceMessage: UiSurfaceShowMessage? = nil, completionState: SurfaceCompletionState? = nil) {
        self.id = id
        self.surfaceType = surfaceType
        self.title = title
        self.data = data
        self.actions = actions
        self.surfaceMessage = surfaceMessage
        self.completionState = completionState
    }
}

/// Tracks the completed state of an inline surface after user interaction.
public struct SurfaceCompletionState: Equatable {
    public let summary: String
    public let submittedData: [String: AnyCodable]?

    public init(summary: String, submittedData: [String: AnyCodable]? = nil) {
        self.summary = summary
        self.submittedData = submittedData
    }
}

/// A file or image attachment associated with a chat message.
public struct ChatAttachment: Identifiable {
    public let id: String
    public let filename: String
    public let mimeType: String
    /// Base64-encoded file data.
    public let data: String
    /// Pre-rendered thumbnail for image attachments (resized to 120px max dimension).
    public let thumbnailData: Data?
    /// Pre-computed length of `data` to avoid O(n) String.count during rendering.
    /// Swift's String.count iterates the entire string to count grapheme clusters,
    /// which is expensive for multi-MB base64 strings on every SwiftUI render pass.
    public let dataLength: Int
    /// Pre-decoded thumbnail image, cached to avoid decoding PNG data on every
    /// SwiftUI render pass (each keystroke triggers a re-evaluation of the composer).
    #if os(macOS)
    public let thumbnailImage: NSImage?
    #elseif os(iOS)
    public let thumbnailImage: UIImage?
    #else
    #error("Unsupported platform")
    #endif

    #if os(macOS)
    public init(id: String, filename: String, mimeType: String, data: String, thumbnailData: Data?, dataLength: Int, thumbnailImage: NSImage?) {
        self.id = id
        self.filename = filename
        self.mimeType = mimeType
        self.data = data
        self.thumbnailData = thumbnailData
        self.dataLength = dataLength
        self.thumbnailImage = thumbnailImage
    }
    #elseif os(iOS)
    public init(id: String, filename: String, mimeType: String, data: String, thumbnailData: Data?, dataLength: Int, thumbnailImage: UIImage?) {
        self.id = id
        self.filename = filename
        self.mimeType = mimeType
        self.data = data
        self.thumbnailData = thumbnailData
        self.dataLength = dataLength
        self.thumbnailImage = thumbnailImage
    }
    #else
    #error("Unsupported platform")
    #endif
}

public struct SkillInvocationData: Equatable {
    public let name: String
    public let emoji: String?
    public let description: String

    public init(name: String, emoji: String?, description: String) {
        self.name = name
        self.emoji = emoji
        self.description = description
    }
}

/// Identifies a content block within a ChatMessage for interleaving order.
public enum ContentBlockRef: Equatable {
    case text(Int)
    case toolCall(Int)
    case surface(Int)
}

public struct ChatMessage: Identifiable {
    public let id: UUID
    public let role: ChatRole
    public var textSegments: [String]
    public var contentOrder: [ContentBlockRef]
    public let timestamp: Date
    public var isStreaming: Bool
    public var status: ChatMessageStatus
    /// Non-nil when this message is an inline tool confirmation request.
    public var confirmation: ToolConfirmationData?
    public var skillInvocation: SkillInvocationData?
    public var attachments: [ChatAttachment]
    public var toolCalls: [ToolCallData]
    public var inlineSurfaces: [InlineSurfaceData]
    /// Streaming code preview from tool input generation (e.g. app_create HTML).
    public var streamingCodePreview: String?
    /// Tool name associated with the streaming code preview.
    public var streamingCodeToolName: String?
    /// The daemon's persisted message ID, populated from history responses.
    /// Nil for freshly streamed messages that haven't been loaded from history.
    /// Used for anchoring diagnostics exports so the daemon can locate the message.
    public var daemonMessageId: String?

    /// Concatenated text from all segments. Backward-compatible computed property.
    public var text: String {
        textSegments.joined()
    }

    public init(id: UUID = UUID(), role: ChatRole, text: String, timestamp: Date = Date(), isStreaming: Bool = false, status: ChatMessageStatus = .sent, confirmation: ToolConfirmationData? = nil, skillInvocation: SkillInvocationData? = nil, attachments: [ChatAttachment] = [], toolCalls: [ToolCallData] = [], inlineSurfaces: [InlineSurfaceData] = []) {
        self.id = id
        self.role = role
        self.textSegments = text.isEmpty ? [] : [text]
        self.contentOrder = text.isEmpty ? [] : [.text(0)]
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.status = status
        self.confirmation = confirmation
        self.skillInvocation = skillInvocation
        self.attachments = attachments
        self.toolCalls = toolCalls
        self.inlineSurfaces = inlineSurfaces
    }

    /// Build a default content order from the legacy `arrivedBeforeText` flag.
    public static func buildDefaultContentOrder(
        textSegmentCount: Int,
        toolCallCount: Int,
        arrivedBeforeText: Bool,
        surfaceCount: Int = 0
    ) -> [ContentBlockRef] {
        var order: [ContentBlockRef] = []
        if arrivedBeforeText {
            for i in 0..<toolCallCount { order.append(.toolCall(i)) }
            for i in 0..<textSegmentCount { order.append(.text(i)) }
            for i in 0..<surfaceCount { order.append(.surface(i)) }
        } else {
            for i in 0..<textSegmentCount { order.append(.text(i)) }
            for i in 0..<toolCallCount { order.append(.toolCall(i)) }
            for i in 0..<surfaceCount { order.append(.surface(i)) }
        }
        return order
    }
}
