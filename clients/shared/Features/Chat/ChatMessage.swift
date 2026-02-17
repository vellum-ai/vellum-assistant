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
            let name = URL(fileURLWithPath: path).lastPathComponent
            return name.isEmpty ? "The assistant wants to write a file" : "The assistant wants to write to \(name)"
        case "file_edit", "host_file_edit":
            let path = (input["path"]?.value as? String) ?? ""
            let name = URL(fileURLWithPath: path).lastPathComponent
            return name.isEmpty ? "The assistant wants to edit a file" : "The assistant wants to edit \(name)"
        case "file_read", "host_file_read":
            let path = (input["path"]?.value as? String) ?? ""
            let name = URL(fileURLWithPath: path).lastPathComponent
            return name.isEmpty ? "The assistant wants to read a file" : "The assistant wants to read \(name)"
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

    /// Friendly, context-aware description for the permission ask.
    public var humanDescription: String {
        switch toolName {
        case "request_system_permission":
            let reason = (input["reason"]?.value as? String) ?? ""
            if reason.isEmpty {
                return "I need \(permissionFriendlyName) to do this for you."
            }
            return reason
        case "bash", "host_bash":
            return Self.describeBashCommand((input["command"]?.value as? String) ?? "")
        case "file_write", "host_file_write":
            let path = (input["path"]?.value as? String) ?? ""
            let name = URL(fileURLWithPath: path).lastPathComponent
            return "I\u{2019}d like to save some changes to \(name) \u{2014} that ok?"
        case "file_edit", "host_file_edit":
            let path = (input["path"]?.value as? String) ?? ""
            let name = URL(fileURLWithPath: path).lastPathComponent
            return "I need to make a quick edit to \(name) \u{2014} cool?"
        case "file_read", "host_file_read":
            let path = (input["path"]?.value as? String) ?? ""
            let name = URL(fileURLWithPath: path).lastPathComponent
            return "Let me take a peek at \(name) \u{2014} alright?"
        case "web_fetch":
            let url = (input["url"]?.value as? String) ?? ""
            if let host = URL(string: url)?.host {
                return "I need to grab some info from \(host) \u{2014} that ok?"
            }
            return "I need to look something up online \u{2014} that ok?"
        case "browser_navigate":
            let url = (input["url"]?.value as? String) ?? ""
            if let host = URL(string: url)?.host {
                return "I want to open \(host) for you \u{2014} cool?"
            }
            return "I want to open a page for you \u{2014} cool?"
        default:
            return "I need to do something on your Mac \u{2014} that ok?"
        }
    }

    /// Extracts a friendly folder/file name from a path in a command.
    private static func friendlyPath(_ command: String) -> String? {
        // Look for paths like ~/Downloads, /Users/.../folder, ./src, etc.
        let patterns = command.split(separator: " ").compactMap { token -> String? in
            let s = String(token)
            guard s.contains("/") || s.hasPrefix("~") else { return nil }
            // Clean trailing slashes and pipes
            let cleaned = s.trimmingCharacters(in: CharacterSet(charactersIn: "/|;&"))
            if cleaned.isEmpty || cleaned == "~" { return nil }
            let url = URL(fileURLWithPath: cleaned.replacingOccurrences(of: "~", with: "/Users/you"))
            let name = url.lastPathComponent
            return name.isEmpty ? nil : name
        }
        return patterns.first
    }

    private static func describeBashCommand(_ command: String) -> String {
        let trimmed = command.trimmingCharacters(in: .whitespaces)
        let words = trimmed.split(separator: " ")
        let first = words.first.map(String.init) ?? ""
        let path = friendlyPath(trimmed)

        switch first {
        case "ls":
            if let p = path {
                return "To check your \(p) folder, I need to run a quick command"
            }
            return "I need to look through some files \u{2014} that ok?"
        case "cat", "head", "tail", "less", "more":
            if let p = path {
                return "I need to read \(p) \u{2014} that ok?"
            }
            return "I need to read a file \u{2014} that ok?"
        case "mkdir":
            if let p = path {
                return "I need to create a \(p) folder \u{2014} cool?"
            }
            return "I need to create a new folder \u{2014} cool?"
        case "rm", "rmdir":
            if let p = path {
                return "I need to delete \(p) \u{2014} is that alright?"
            }
            return "I need to delete some files \u{2014} is that alright?"
        case "cp":
            return "I need to copy some files over \u{2014} that ok?"
        case "mv":
            return "I need to move something around \u{2014} that ok?"
        case "git":
            let sub = words.dropFirst().first.map(String.init) ?? ""
            switch sub {
            case "push": return "I\u{2019}m ready to push your code \u{2014} should I go ahead?"
            case "pull": return "Let me pull the latest code for you \u{2014} cool?"
            case "commit": return "I want to commit your changes \u{2014} good to go?"
            case "clone": return "I need to clone a repo \u{2014} that ok?"
            case "checkout", "switch": return "I want to switch branches \u{2014} cool?"
            case "status": return "Let me check what\u{2019}s changed \u{2014} that ok?"
            case "diff": return "I want to see what\u{2019}s changed in the code"
            case "add": return "I need to stage some files for commit"
            case "stash": return "I\u{2019}ll set aside your changes for now \u{2014} ok?"
            case "merge": return "I want to merge these branches \u{2014} should I?"
            case "rebase": return "I need to rebase your commits \u{2014} that ok?"
            case "log": return "Let me check the commit history"
            case "fetch": return "Let me check for updates from the remote"
            case "reset": return "I need to reset some files \u{2014} is that alright?"
            default: return "I need to run a git command \u{2014} that ok?"
            }
        case "npm", "npx":
            let sub = words.dropFirst().first.map(String.init) ?? ""
            switch sub {
            case "install", "i", "ci": return "I need to install some packages \u{2014} that ok?"
            case "run": return "I need to run a project script \u{2014} cool?"
            case "test": return "Let me run the tests for you"
            default: return "I need to run an npm command \u{2014} that ok?"
            }
        case "bun", "bunx":
            return "I need to run a Bun command \u{2014} that ok?"
        case "yarn", "pnpm":
            return "I need to install some packages \u{2014} that ok?"
        case "pip", "pip3":
            return "I need to manage some Python packages \u{2014} cool?"
        case "brew":
            return "I need to use Homebrew real quick \u{2014} that ok?"
        case "curl", "wget":
            return "I need to download something \u{2014} that ok?"
        case "python", "python3":
            return "I need to run a Python script \u{2014} cool?"
        case "node":
            return "I need to run a script \u{2014} cool?"
        case "swift":
            return "I need to run a Swift command \u{2014} that ok?"
        case "xcodebuild":
            return "I need to build the project \u{2014} that ok?"
        case "open":
            if let p = path {
                return "I want to open \(p) for you \u{2014} cool?"
            }
            return "I want to open something for you \u{2014} cool?"
        case "sudo":
            return "I need admin access to run this \u{2014} is that alright?"
        case "kill", "pkill", "killall":
            return "I need to stop a running process \u{2014} ok?"
        case "docker":
            return "I need to run a Docker command \u{2014} that ok?"
        case "ssh":
            return "I need to connect to a remote server \u{2014} that ok?"
        case "find", "grep", "rg", "ag":
            return "I need to search for something \u{2014} that ok?"
        default:
            return "I need to run a quick command \u{2014} that ok?"
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
