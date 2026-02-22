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
    /// When false, hide "Always Allow" and trust-rule persistence controls.
    public let persistentDecisionsAllowed: Bool
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
        case "bash", "host_bash":                    return "Run Command"
        case "file_write", "host_file_write":        return "Write File"
        case "file_edit", "host_file_edit":           return "Edit File"
        case "file_read", "host_file_read":           return "Read File"
        case "web_fetch":                             return "Fetch URL"
        case "web_search":                            return "Web Search"
        case "credential_store":                      return "Secure Storage"
        case "account_manage":                        return "Account"
        case _ where toolName.hasPrefix("browser_"):  return "Browser"
        case _ where toolName.hasPrefix("schedule_"): return "Scheduling"
        case _ where toolName.hasPrefix("watcher_"):  return "Watcher"
        case _ where toolName.hasPrefix("memory_"):   return "Memory"
        case "skill_load":                            return "Skill"
        case "evaluate_typescript_code":              return "Code Sandbox"
        case "reminder":                              return "Reminder"
        case "document_create", "document_update":    return "Document"
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
        case "bash", "host_bash":                    return "terminal"
        case "file_write", "host_file_write":        return "doc.badge.plus"
        case "file_edit", "host_file_edit":           return "pencil.line"
        case "file_read", "host_file_read":           return "doc.text"
        case "web_fetch":                             return "arrow.down.circle"
        case "web_search":                            return "magnifyingglass"
        case "credential_store":                      return "lock.shield"
        case "account_manage":                        return "person.crop.circle"
        case _ where toolName.hasPrefix("browser_"):  return "globe"
        case _ where toolName.hasPrefix("schedule_"): return "calendar"
        case _ where toolName.hasPrefix("watcher_"):  return "eye"
        case _ where toolName.hasPrefix("memory_"):   return "brain"
        case "skill_load":                            return "puzzlepiece.extension"
        case "evaluate_typescript_code":              return "chevron.left.forwardslash.chevron.right"
        case "reminder":                              return "bell"
        case "document_create", "document_update":    return "doc.richtext"
        default:                                      return "puzzlepiece.extension"
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

    /// Short question asking the user to approve the action.
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
            if !r.isEmpty { return "Allow running a shell command \(r)?" }
            return "Allow running a shell command?"
        case "file_write", "host_file_write":
            if !r.isEmpty { return "Allow writing a file \(r)?" }
            let path = (input["path"]?.value as? String) ?? ""
            if path.isEmpty { return "Allow writing a file?" }
            return "Allow writing to \(URL(fileURLWithPath: path).lastPathComponent)?"
        case "file_edit", "host_file_edit":
            if !r.isEmpty { return "Allow editing a file \(r)?" }
            let path = (input["path"]?.value as? String) ?? ""
            if path.isEmpty { return "Allow editing a file?" }
            return "Allow editing \(URL(fileURLWithPath: path).lastPathComponent)?"
        case "file_read", "host_file_read":
            if !r.isEmpty { return "Allow reading a file \(r)?" }
            let path = (input["path"]?.value as? String) ?? ""
            if path.isEmpty { return "Allow reading a file?" }
            return "Allow reading \(URL(fileURLWithPath: path).lastPathComponent)?"
        case "web_fetch":
            if !r.isEmpty { return "Allow fetching a URL \(r)?" }
            let url = (input["url"]?.value as? String) ?? ""
            if let host = URL(string: url)?.host {
                return "Allow fetching data from \(host)?"
            }
            return "Allow fetching a URL?"
        case "browser_navigate":
            if !r.isEmpty { return "Allow opening a page \(r)?" }
            let url = (input["url"]?.value as? String) ?? ""
            if let host = URL(string: url)?.host {
                return "Allow opening \(host)?"
            }
            return "Allow opening a page?"
        case "credential_store":
            let action = (input["action"]?.value as? String) ?? ""
            let service = (input["service"]?.value as? String) ?? ""
            switch action {
            case "oauth2_connect":
                return service.isEmpty
                    ? "Allow connecting an account?"
                    : "Allow connecting your \(service.capitalized) account?"
            case "store":
                return service.isEmpty
                    ? "Allow saving a credential securely?"
                    : "Allow saving a \(service) credential securely?"
            case "delete":
                return service.isEmpty
                    ? "Allow removing a stored credential?"
                    : "Allow removing a \(service) credential?"
            case "prompt":
                return service.isEmpty
                    ? "Allow asking for a credential?"
                    : "Allow asking for a \(service) credential?"
            default:
                return "Allow accessing secure storage?"
            }
        default:
            let tc = toolCategory.lowercased()
            if !r.isEmpty { return "Allow using \(tc) \(r)?" }
            return "Allow using \(tc)?"
        }
    }

    public init(requestId: String, toolName: String, input: [String: AnyCodable] = [:], riskLevel: String, diff: ConfirmationRequestMessage.ConfirmationDiffInfo? = nil, allowlistOptions: [ConfirmationRequestMessage.ConfirmationAllowlistOption] = [], scopeOptions: [ConfirmationRequestMessage.ConfirmationScopeOption] = [], executionTarget: String? = nil, persistentDecisionsAllowed: Bool = true, state: ToolConfirmationState = .pending) {
        self.requestId = requestId
        self.toolName = toolName
        self.input = input
        self.riskLevel = riskLevel
        self.diff = diff
        self.allowlistOptions = allowlistOptions
        self.scopeOptions = scopeOptions
        self.executionTarget = executionTarget
        self.persistentDecisionsAllowed = persistentDecisionsAllowed
        self.state = state
    }

    /// Build a `ToolConfirmationData` from a tool permission simulation response.
    /// Maps the simulation-specific prompt payload types to the confirmation types
    /// used by `ToolConfirmationBubble`.
    public static func fromSimulation(
        toolName: String,
        input: [String: AnyCodable],
        riskLevel: String,
        executionTarget: String?,
        promptPayload: IPCToolPermissionSimulateResponsePromptPayload
    ) -> ToolConfirmationData {
        let allowlistOptions = promptPayload.allowlistOptions.map { opt in
            IPCConfirmationRequestAllowlistOption(
                label: opt.label,
                description: opt.description,
                pattern: opt.pattern
            )
        }
        let scopeOptions = promptPayload.scopeOptions.map { opt in
            IPCConfirmationRequestScopeOption(label: opt.label, scope: opt.scope)
        }
        return ToolConfirmationData(
            requestId: "simulation",
            toolName: toolName,
            input: input,
            riskLevel: riskLevel,
            allowlistOptions: allowlistOptions,
            scopeOptions: scopeOptions,
            executionTarget: executionTarget,
            persistentDecisionsAllowed: promptPayload.persistentDecisionsAllowed
        )
    }
}

/// A single sub-tool invocation within a claude_code tool call.
public struct ClaudeCodeSubStep: Identifiable, Equatable {
    public let id: UUID
    public let toolName: String
    public let inputSummary: String
    public var isComplete: Bool
    public var isError: Bool
    public let startedAt: Date
    /// Stable identifier from the Claude Code SDK (tool_use_id), used for precise matching on tool_complete events.
    public let subToolId: String?

    public init(id: UUID = UUID(), toolName: String, inputSummary: String, isComplete: Bool = false, isError: Bool = false, startedAt: Date = Date(), subToolId: String? = nil) {
        self.id = id
        self.toolName = toolName
        self.inputSummary = inputSummary
        self.isComplete = isComplete
        self.isError = isError
        self.startedAt = startedAt
        self.subToolId = subToolId
    }

    /// Human-readable label for the sub-tool.
    public var friendlyName: String {
        switch toolName.lowercased() {
        case "read", "file_read":       return "Read File"
        case "edit", "file_edit":       return "Edit File"
        case "write", "file_write":     return "Write File"
        case "bash":                    return "Run Command"
        case "glob":                    return "Find Files"
        case "grep":                    return "Search Files"
        case "websearch", "web_search": return "Web Search"
        case "webfetch", "web_fetch":   return "Fetch URL"
        case "task":                    return "Run Agent"
        case "notebookedit":            return "Edit Notebook"
        case "notebookread":            return "Read Notebook"
        default:
            return toolName
                .replacingOccurrences(of: "_", with: " ")
                .split(separator: " ")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    /// SF Symbol name for the sub-tool type.
    public var toolIcon: String {
        switch toolName.lowercased() {
        case "read", "file_read":       return "doc.text"
        case "edit", "file_edit":       return "pencil.line"
        case "write", "file_write":     return "doc.badge.plus"
        case "bash":                    return "terminal"
        case "glob":                    return "folder.badge.magnifyingglass"
        case "grep":                    return "magnifyingglass"
        case "websearch", "web_search": return "magnifyingglass"
        case "webfetch", "web_fetch":   return "arrow.down.circle"
        case "task":                    return "person.2"
        default:                        return "puzzlepiece.extension"
        }
    }
}

/// Data for a tool call displayed inline in an assistant message.
public struct ToolCallData: Identifiable, Equatable {
    public let id: UUID
    public let toolName: String
    public let inputSummary: String
    /// Full (untruncated) input text for display in expanded views.
    public let inputFull: String
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
    /// Human-readable building status from app tool input (e.g. "Adding dark mode styles").
    public var buildingStatus: String?
    /// Sub-tool steps for claude_code tool calls (live progress tracking).
    public var claudeCodeSteps: [ClaudeCodeSubStep] = []
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
            && lhs.inputFull == rhs.inputFull
            && lhs.imageData == rhs.imageData
            && lhs.buildingStatus == rhs.buildingStatus
            && lhs.claudeCodeSteps == rhs.claudeCodeSteps
    }

    public init(id: UUID = UUID(), toolName: String, inputSummary: String, inputFull: String? = nil, result: String? = nil, isError: Bool = false, isComplete: Bool = false, arrivedBeforeText: Bool = true, imageData: String? = nil, startedAt: Date? = nil, completedAt: Date? = nil) {
        self.id = id
        self.toolName = toolName
        self.inputSummary = inputSummary
        self.inputFull = inputFull ?? inputSummary
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

    /// Human-readable label for the tool (e.g. "Run Command" instead of "bash").
    public var friendlyName: String {
        switch toolName {
        case "bash", "host_bash":                  return "Run Command"
        case "file_write", "host_file_write":      return "Write File"
        case "file_edit", "host_file_edit":        return "Edit File"
        case "file_read", "host_file_read":        return "Read File"
        case "glob":                               return "Find Files"
        case "grep":                               return "Search Files"
        case "web_fetch":                          return "Fetch URL"
        case "browser_navigate":                   return "Open Page"
        case "browser_screenshot":                 return "Take Screenshot"
        case "browser_click":                      return "Click Element"
        case "browser_type":                       return "Type Text"
        case "app_create":                         return "Create App"
        case "app_update":                         return "Update App"
        case "request_system_permission":          return "Request Permission"
        default:
            return toolName
                .replacingOccurrences(of: "_", with: " ")
                .split(separator: " ")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    /// SF Symbol name appropriate for the tool type.
    public var toolIcon: String {
        switch toolName {
        case "bash", "host_bash":                  return "terminal"
        case "file_write", "host_file_write":      return "doc.badge.plus"
        case "file_edit", "host_file_edit":        return "pencil.line"
        case "file_read", "host_file_read":        return "doc.text"
        case "glob":                               return "folder.badge.magnifyingglass"
        case "grep":                               return "magnifyingglass"
        case "web_fetch":                          return "arrow.down.circle"
        case "browser_navigate":                   return "globe"
        case "browser_screenshot":                 return "camera.viewfinder"
        case "browser_click":                      return "cursorarrow.click"
        case "browser_type":                       return "keyboard"
        case "app_create", "app_update":           return "apps.iphone"
        case "request_system_permission":          return "lock.shield"
        default:                                   return "puzzlepiece.extension"
        }
    }

    /// Brief past-tense plain-language description of what was done.
    public var actionDescription: String {
        let name = lastName(of: inputSummary)
        switch toolName {
        case "bash", "host_bash":
            return inputSummary.isEmpty ? "Ran a command" : interpretBashCommand(inputSummary)
        case "file_edit", "host_file_edit":
            return name.isEmpty ? "Made some edits" : "Edited \(name)"
        case "file_write", "host_file_write":
            return name.isEmpty ? "Created a file" : "Created \(name)"
        case "file_read", "host_file_read":
            return name.isEmpty ? "Read a file" : "Read \(name)"
        case "glob":
            return interpretGlobPattern(inputSummary)
        case "grep":
            return inputSummary.isEmpty ? "Searched through files" : "Searched for \"\(truncated(inputSummary, to: 50))\""
        case "web_fetch":
            if let host = URL(string: inputSummary)?.host { return "Fetched data from \(host)" }
            return "Fetched a webpage"
        case "browser_navigate":
            if let host = URL(string: inputSummary)?.host { return "Opened \(host)" }
            return "Opened a page"
        case "browser_screenshot":
            return "Took a screenshot"
        case "browser_click":
            return inputSummary.isEmpty ? "Clicked something on the page" : "Clicked \"\(truncated(inputSummary, to: 50))\""
        case "browser_type":
            return "Typed in a field"
        case "app_create":
            return "Created an app"
        case "app_update":
            return "Updated the app"
        case "app_open":
            return inputSummary.isEmpty ? "Opened an app" : "Opened \(inputSummary)"
        case "request_system_permission":
            return "Requested system access"
        case "web_search":
            return inputSummary.isEmpty ? "Searched the web" : "Searched for \"\(truncated(inputSummary, to: 50))\""
        case "memory_save", "memory_update":
            return "Saved a memory"
        case "memory_search":
            return inputSummary.isEmpty ? "Recalled memories" : "Recalled info about \"\(truncated(inputSummary, to: 40))\""
        case "task_run":
            return inputSummary.isEmpty ? "Ran a task" : "Ran \"\(truncated(inputSummary, to: 50))\""
        case "task_save":
            return "Saved a task"
        case "task_list", "work_item_list", "task_list_show":
            return "Checked the task list"
        case "task_delete":
            return "Deleted a task"
        case "work_item_enqueue", "task_list_add":
            return "Queued work"
        case "swarm_delegate":
            return inputSummary.isEmpty ? "Delegated to an agent" : "Delegated: \(truncated(inputSummary, to: 50))"
        case "claude_code":
            return inputSummary.isEmpty ? "Ran Claude Code" : truncated(inputSummary, to: 60)
        case "evaluate_typescript_code":
            return "Evaluated a code snippet"
        case "followup_create":
            return inputSummary.isEmpty ? "Set a follow-up" : "Set a reminder: \(truncated(inputSummary, to: 50))"
        case "followup_list":
            return "Checked follow-ups"
        case "followup_resolve":
            return "Resolved a follow-up"
        case "contact_search":
            return inputSummary.isEmpty ? "Looked up a contact" : "Looked up \"\(truncated(inputSummary, to: 40))\""
        case "contact_upsert":
            return inputSummary.isEmpty ? "Saved a contact" : "Saved contact \"\(truncated(inputSummary, to: 40))\""
        case "contact_merge":
            return "Merged contacts"
        case "asset_search":
            return inputSummary.isEmpty ? "Searched assets" : "Searched for \"\(truncated(inputSummary, to: 40))\""
        case "asset_materialize":
            return "Prepared an asset"
        case "computer_use_key":
            return inputSummary.isEmpty ? "Pressed a key" : "Pressed \(inputSummary)"
        case "computer_use_type_text":
            return inputSummary.isEmpty ? "Typed text" : "Typed \"\(truncated(inputSummary, to: 40))\""
        case "computer_use_scroll":
            return "Scrolled the page"
        case "computer_use_drag":
            return "Dragged an element"
        case "computer_use_open_app":
            return inputSummary.isEmpty ? "Opened an app" : "Opened \(inputSummary)"
        case "computer_use_run_applescript":
            return "Ran an AppleScript"
        case "computer_use_wait":
            return "Waited for the screen"
        case "computer_use_request_control":
            return "Requested computer control"
        case "computer_use_done", "computer_use_respond":
            return "Finished the task"
        case "ui_show":
            return inputSummary.isEmpty ? "Showed a panel" : "Opened \(inputSummary)"
        case "ui_update":
            return "Updated the panel"
        case "ui_dismiss":
            return "Closed the panel"
        case "request_file":
            return "Requested a file"
        case "playbook_create":
            return "Created a playbook"
        case "playbook_update":
            return "Updated a playbook"
        case "playbook_list":
            return "Listed playbooks"
        default:
            return friendlyName
        }
    }

    private func interpretBashCommand(_ cmd: String) -> String {
        let tokens = cmd.trimmingCharacters(in: .whitespaces)
            .components(separatedBy: .whitespaces)
            .filter { !$0.isEmpty }
        guard let first = tokens.first else { return "Ran a command" }
        let base = (first as NSString).lastPathComponent.lowercased()

        // Returns the last non-flag argument after `skip` tokens, or nil.
        func target(skip: Int = 1) -> String? {
            let t = tokens.dropFirst(skip).last(where: { !$0.hasPrefix("-") })
            return t.map { lastName(of: $0) }.flatMap { $0.isEmpty ? nil : $0 }
        }

        switch base {
        case "ls", "find", "tree":
            if let dir = target() { return "Listed \(dir)" }
            return "Listed files"
        case "cat", "less", "more", "head", "tail":
            let file = tokens.dropFirst().first(where: { !$0.hasPrefix("-") }).map { lastName(of: $0) } ?? ""
            return file.isEmpty ? "Read file contents" : "Read \(file)"
        case "git":
            switch tokens.dropFirst().first ?? "" {
            case "status":          return "Checked git status"
            case "diff":            return "Reviewed code changes"
            case "add":             return "Staged changes"
            case "commit":          return "Committed changes"
            case "push":            return "Pushed code"
            case "pull":            return "Pulled latest changes"
            case "fetch":           return "Fetched remote changes"
            case "checkout", "switch":
                let branch = tokens.dropFirst(2).first(where: { !$0.hasPrefix("-") }) ?? ""
                return branch.isEmpty ? "Switched branch" : "Switched to \(branch)"
            case "log":             return "Reviewed commit history"
            case "clone":           return "Cloned repository"
            case "merge":
                let branch = tokens.dropFirst(2).first(where: { !$0.hasPrefix("-") }) ?? ""
                return branch.isEmpty ? "Merged branch" : "Merged \(branch)"
            case "rebase":          return "Rebased branch"
            case "stash":           return "Stashed changes"
            case "reset", "restore": return "Undid changes"
            default:                return "Used git"
            }
        case "npm", "yarn", "bun", "pnpm":
            switch tokens.dropFirst().first ?? "" {
            case "install", "i":    return "Installed dependencies"
            case "add":
                let pkg = tokens.dropFirst(2).first(where: { !$0.hasPrefix("-") }) ?? ""
                return pkg.isEmpty ? "Installed a package" : "Installed \(pkg)"
            case "remove", "uninstall":
                let pkg = tokens.dropFirst(2).first(where: { !$0.hasPrefix("-") }) ?? ""
                return pkg.isEmpty ? "Removed a package" : "Removed \(pkg)"
            case "run":
                let script = tokens.dropFirst().dropFirst().first(where: { !$0.hasPrefix("-") }) ?? ""
                return script.isEmpty ? "Ran a script" : "Ran \(script)"
            case "test":    return "Ran tests"
            case "build":   return "Built the project"
            case "start":   return "Started the server"
            default:        return "Ran a script"
            }
        case "swift":
            return (tokens.dropFirst().first ?? "") == "test" ? "Ran tests" : "Built the project"
        case "python", "python3":
            let script = tokens.dropFirst().first(where: { !$0.hasPrefix("-") }).map { lastName(of: $0) } ?? ""
            return script.isEmpty ? "Ran a Python script" : "Ran \(script)"
        case "node":
            let script = tokens.dropFirst().first(where: { !$0.hasPrefix("-") }).map { lastName(of: $0) } ?? ""
            return script.isEmpty ? "Ran a Node script" : "Ran \(script)"
        case "mkdir":
            return target().map { "Created folder \($0)" } ?? "Created a folder"
        case "rm", "rmdir":
            return target().map { "Deleted \($0)" } ?? "Deleted files"
        case "cp":
            return target().map { "Copied \($0)" } ?? "Copied files"
        case "mv":
            return target().map { "Moved \($0)" } ?? "Moved files"
        case "chmod", "chown":
            return target().map { "Updated permissions on \($0)" } ?? "Updated file permissions"
        case "curl", "wget":
            let url = tokens.dropFirst().first(where: { !$0.hasPrefix("-") }) ?? ""
            if let host = URL(string: url)?.host { return "Fetched from \(host)" }
            return "Made a network request"
        case "open":
            return target().map { "Opened \($0)" } ?? "Opened a file"
        case "defaults":            return "Updated system settings"
        case "pkill", "kill", "killall":
            return target().map { "Stopped \($0)" } ?? "Stopped a process"
        case "build.sh":            return "Built the project"
        case "echo", "printf":      return "Output text"
        case "export", "env":       return "Set environment variables"
        default:
            // Show the command name itself as a last resort
            return "Ran \(base)"
        }
    }

    private func interpretGlobPattern(_ pattern: String) -> String {
        guard !pattern.isEmpty else { return "Searched for files" }
        let extMap: [String: String] = [
            "swift": "Swift", "ts": "TypeScript", "js": "JavaScript",
            "tsx": "TypeScript", "jsx": "JavaScript", "py": "Python",
            "go": "Go", "rs": "Rust", "json": "JSON", "md": "Markdown",
            "html": "HTML", "css": "CSS", "yaml": "YAML", "yml": "YAML",
            "sh": "shell scripts", "sql": "SQL", "kt": "Kotlin", "java": "Java"
        ]
        if let ext = pattern.components(separatedBy: ".").last,
           ext.count <= 6, !ext.contains("/"), !ext.contains("*"),
           let lang = extMap[ext.lowercased()] {
            return "Found \(lang) files"
        }
        // Fall back to showing the pattern itself
        return "Found \"\(truncated(pattern, to: 50))\" files"
    }

    private func lastName(of path: String) -> String {
        guard !path.isEmpty else { return "" }
        return URL(fileURLWithPath: path).lastPathComponent
    }

    private func truncated(_ s: String, to length: Int) -> String {
        s.count > length ? String(s.prefix(length - 1)) + "…" : s
    }
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
    /// Base64-encoded file data. Empty when the attachment was too large to embed
    /// in the history_response — use ``fetchData(port:)`` to load it lazily.
    public let data: String
    /// Pre-rendered thumbnail for image attachments (resized to 120px max dimension).
    public let thumbnailData: Data?
    /// Pre-computed length of `data` to avoid O(n) String.count during rendering.
    /// Swift's String.count iterates the entire string to count grapheme clusters,
    /// which is expensive for multi-MB base64 strings on every SwiftUI render pass.
    public let dataLength: Int
    /// Original file size in bytes. Non-nil when `data` is empty because the
    /// attachment was too large to inline in the history response.
    public let sizeBytes: Int?
    /// Pre-decoded thumbnail image, cached to avoid decoding PNG data on every
    /// SwiftUI render pass (each keystroke triggers a re-evaluation of the composer).
    #if os(macOS)
    public let thumbnailImage: NSImage?
    #elseif os(iOS)
    public let thumbnailImage: UIImage?
    #else
    #error("Unsupported platform")
    #endif

    /// Whether this attachment's binary data was omitted to keep the IPC payload small.
    /// The client should fetch it lazily via the HTTP endpoint when the user interacts.
    public var isLazyLoad: Bool { data.isEmpty && sizeBytes != nil }

    #if os(macOS)
    public init(id: String, filename: String, mimeType: String, data: String, thumbnailData: Data?, dataLength: Int, sizeBytes: Int? = nil, thumbnailImage: NSImage?) {
        self.id = id
        self.filename = filename
        self.mimeType = mimeType
        self.data = data
        self.thumbnailData = thumbnailData
        self.dataLength = dataLength
        self.sizeBytes = sizeBytes
        self.thumbnailImage = thumbnailImage
    }
    #elseif os(iOS)
    public init(id: String, filename: String, mimeType: String, data: String, thumbnailData: Data?, dataLength: Int, sizeBytes: Int? = nil, thumbnailImage: UIImage?) {
        self.id = id
        self.filename = filename
        self.mimeType = mimeType
        self.data = data
        self.thumbnailData = thumbnailData
        self.dataLength = dataLength
        self.sizeBytes = sizeBytes
        self.thumbnailImage = thumbnailImage
    }
    #else
    #error("Unsupported platform")
    #endif
}

public struct ModelPickerData: Equatable {
    public init() {}
}

public struct ModelListData: Equatable {
    public init() {}
}

public struct CommandListData: Equatable {
    public init() {}
}

public enum SubagentStatus: String, Equatable, Sendable {
    case pending
    case running
    case awaitingInput = "awaiting_input"
    case completed
    case failed
    case aborted
    case unknown

    public init(wire: String) {
        self = SubagentStatus(rawValue: wire) ?? .unknown
    }

    public var isTerminal: Bool {
        switch self {
        case .completed, .failed, .aborted: return true
        default: return false
        }
    }
}

public struct SubagentInfo: Equatable, Identifiable {
    public let id: String
    public let label: String
    public var status: SubagentStatus
    public var error: String?
    /// The chat message ID that was active when this subagent was spawned.
    /// Used to render the subagent chip inline after the spawning message.
    public var parentMessageId: UUID?
    /// The subagent's own conversation ID, used for lazy-loading detail events.
    public var conversationId: String?

    public init(id: String, label: String, status: SubagentStatus = .pending, parentMessageId: UUID? = nil, conversationId: String? = nil) {
        self.id = id
        self.label = label
        self.status = status
        self.parentMessageId = parentMessageId
        self.conversationId = conversationId
    }

    public var isTerminal: Bool { status.isTerminal }
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
    public var timestamp: Date
    public var isStreaming: Bool
    public var status: ChatMessageStatus
    /// Non-nil when this message is an inline tool confirmation request.
    public var confirmation: ToolConfirmationData?
    public var skillInvocation: SkillInvocationData?
    public var modelPicker: ModelPickerData?
    public var modelList: ModelListData?
    public var commandList: CommandListData?
    public var attachments: [ChatAttachment]
    public var toolCalls: [ToolCallData]
    public var inlineSurfaces: [InlineSurfaceData]
    /// Streaming code preview from tool input generation (e.g. app_create HTML).
    public var streamingCodePreview: String?
    /// Tool name associated with the streaming code preview.
    public var streamingCodeToolName: String?
    /// When true, this message represents a session error (rate limit, network failure, etc.)
    /// and should be rendered with distinct error styling (red box) instead of a normal bubble.
    public var isError: Bool
    /// The daemon's persisted message ID, populated from history responses.
    /// Nil for freshly streamed messages that haven't been loaded from history.
    /// Used for anchoring diagnostics exports so the daemon can locate the message.
    public var daemonMessageId: String?
    /// When true, this message is a subagent notification (e.g. completed/failed/aborted)
    /// reconstructed from history. It should be hidden from the chat UI since the
    /// corresponding subagent chip conveys the same information.
    public var isSubagentNotification: Bool = false

    /// Concatenated text from all segments. Backward-compatible computed property.
    public var text: String {
        textSegments.joined()
    }

    public init(id: UUID = UUID(), role: ChatRole, text: String, timestamp: Date = Date(), isStreaming: Bool = false, status: ChatMessageStatus = .sent, confirmation: ToolConfirmationData? = nil, skillInvocation: SkillInvocationData? = nil, attachments: [ChatAttachment] = [], toolCalls: [ToolCallData] = [], inlineSurfaces: [InlineSurfaceData] = [], isError: Bool = false) {
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
        self.isError = isError
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
