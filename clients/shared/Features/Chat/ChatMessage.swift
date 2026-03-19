import Foundation
import os
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
    /// Message is buffered in the local offline queue pending daemon reconnect.
    case pendingOffline
    /// HTTP send failed — the message was never delivered to the daemon.
    case sendFailed
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
    public let diff: ConfirmationRequestDiff?
    public let allowlistOptions: [ConfirmationRequestAllowlistOption]
    public let scopeOptions: [ConfirmationRequestScopeOption]
    public let executionTarget: String?
    /// When false, hide "Always Allow" and trust-rule persistence controls.
    public let persistentDecisionsAllowed: Bool
    /// Which temporary approval options the daemon supports for this request (e.g. "allow_10m", "allow_conversation").
    public let temporaryOptionsAvailable: [String]
    /// The tool_use block ID for client-side correlation with specific tool calls.
    public let toolUseId: String?
    public var state: ToolConfirmationState = .pending
    /// The decision string that was used to approve (e.g. "allow", "allow_10m", "allow_conversation", "always_allow").
    /// Set when the state transitions to `.approved`.
    public var approvedDecision: String?
    /// When set, `toolCategory` returns this instead of deriving from `toolName`.
    /// Used for confirmation data synthesized from persisted per-tool-call labels.
    public var _overrideToolCategory: String?

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
        case "schedule_create":
            let name = (input["name"]?.value as? String) ?? ""
            return name.isEmpty
                ? "The assistant wants to create a schedule"
                : "The assistant wants to create a schedule: \(name)"
        case "schedule_update":
            return "The assistant wants to update a schedule"
        case "schedule_delete":
            return "The assistant wants to delete a schedule"
        default:
            return "The assistant wants to use \(toolName)"
        }
    }

    /// Structured preview of ALL input parameters, formatted as key: value lines.
    /// Used in the "More details" section so the user can see exactly what will happen.
    public var fullInputPreview: String {
        switch toolName {
        case "bash":
            let command = (input["command"]?.value as? String) ?? ""
            var extras: [String] = []
            if let networkMode = input["network_mode"]?.value as? String, !networkMode.isEmpty {
                extras.append("network_mode: \(networkMode)")
            }
            if let credentialIds = input["credential_ids"]?.value as? [Any], !credentialIds.isEmpty {
                let ids = credentialIds.compactMap { $0 as? String }
                if !ids.isEmpty { extras.append("credential_ids: \(ids.joined(separator: ", "))") }
            }
            if let timeout = input["timeout_seconds"]?.value {
                extras.append("timeout_seconds: \(timeout)")
            }
            if extras.isEmpty { return command }
            return command + "\n\n" + extras.joined(separator: "\n")
        case "host_bash":
            let command = (input["command"]?.value as? String) ?? ""
            if let timeout = input["timeout_seconds"]?.value {
                return command + "\n\ntimeout_seconds: \(timeout)"
            }
            return command
        default:
            break
        }

        let lines: [String] = input.keys.sorted().compactMap { key in
            guard let value = input[key]?.value else { return nil }
            let formatted: String
            if let str = value as? String {
                formatted = str
            } else if let bool = value as? Bool {
                formatted = bool ? "true" : "false"
            } else if let num = value as? Int {
                formatted = "\(num)"
            } else if let num = value as? Double {
                formatted = "\(num)"
            } else {
                formatted = "\(value)"
            }
            return "\(key): \(formatted)"
        }
        return lines.joined(separator: "\n")
    }

    /// Unified diff preview for file change confirmations.
    /// Uses an exact LCS diff for typical file sizes and a full, non-truncating
    /// linear fallback for very large inputs.
    public var unifiedDiffPreview: String? {
        guard let diff else { return nil }
        return Self.buildUnifiedDiff(
            oldContent: diff.oldContent,
            newContent: diff.newContent,
            filePath: diff.filePath
        )
    }

    private static let diffContextLines = 3
    private static let maxExactDiffLines = 1000

    private enum DiffEntryType {
        case same
        case add
        case remove
    }

    private struct DiffEntry {
        let type: DiffEntryType
        let line: String
    }

    private struct DiffHunk {
        let oldStart: Int
        let oldCount: Int
        let newStart: Int
        let newCount: Int
        let lines: [DiffEntry]
    }

    private static func buildUnifiedDiff(oldContent: String, newContent: String, filePath: String) -> String {
        if oldContent == newContent { return "" }

        let oldLines = oldContent.components(separatedBy: "\n")
        let newLines = newContent.components(separatedBy: "\n")

        if oldLines.count > maxExactDiffLines || newLines.count > maxExactDiffLines {
            return buildLargeUnifiedDiff(oldLines: oldLines, newLines: newLines, filePath: filePath)
        }

        let entries = computeLineDiff(oldLines: oldLines, newLines: newLines)
        let hunks = buildHunks(entries: entries)
        if hunks.isEmpty { return "" }

        var output = "--- a/\(filePath)\n"
        output += "+++ b/\(filePath)\n"
        for hunk in hunks {
            output += "@@ -\(hunk.oldStart),\(hunk.oldCount) +\(hunk.newStart),\(hunk.newCount) @@\n"
            for entry in hunk.lines {
                switch entry.type {
                case .same:
                    output += " \(entry.line)\n"
                case .remove:
                    output += "-\(entry.line)\n"
                case .add:
                    output += "+\(entry.line)\n"
                }
            }
        }
        return output
    }

    private static func buildLargeUnifiedDiff(oldLines: [String], newLines: [String], filePath: String) -> String {
        var output = "--- a/\(filePath)\n"
        output += "+++ b/\(filePath)\n"
        output += "@@ -1,\(oldLines.count) +1,\(newLines.count) @@\n"
        for line in oldLines {
            output += "-\(line)\n"
        }
        for line in newLines {
            output += "+\(line)\n"
        }
        return output
    }

    private static func computeLineDiff(oldLines: [String], newLines: [String]) -> [DiffEntry] {
        let m = oldLines.count
        let n = newLines.count

        var dp = Array(repeating: Array(repeating: 0, count: n + 1), count: m + 1)
        if m > 0 && n > 0 {
            for i in 1...m {
                for j in 1...n {
                    if oldLines[i - 1] == newLines[j - 1] {
                        dp[i][j] = dp[i - 1][j - 1] + 1
                    } else {
                        dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])
                    }
                }
            }
        }

        var reversed: [DiffEntry] = []
        var i = m
        var j = n
        while i > 0 || j > 0 {
            if i > 0, j > 0, oldLines[i - 1] == newLines[j - 1] {
                reversed.append(DiffEntry(type: .same, line: oldLines[i - 1]))
                i -= 1
                j -= 1
            } else if j > 0, (i == 0 || dp[i][j - 1] >= dp[i - 1][j]) {
                reversed.append(DiffEntry(type: .add, line: newLines[j - 1]))
                j -= 1
            } else if i > 0 {
                reversed.append(DiffEntry(type: .remove, line: oldLines[i - 1]))
                i -= 1
            }
        }

        return Array(reversed.reversed())
    }

    private static func buildHunks(entries: [DiffEntry]) -> [DiffHunk] {
        var changeRanges: [(start: Int, end: Int)] = []
        for i in entries.indices {
            if entries[i].type != .same {
                if !changeRanges.isEmpty,
                   i - changeRanges[changeRanges.count - 1].end <= diffContextLines * 2 {
                    changeRanges[changeRanges.count - 1].end = i + 1
                } else {
                    changeRanges.append((start: i, end: i + 1))
                }
            }
        }

        var hunks: [DiffHunk] = []
        for range in changeRanges {
            let contextStart = max(0, range.start - diffContextLines)
            let contextEnd = min(entries.count, range.end + diffContextLines)
            let hunkEntries = Array(entries[contextStart..<contextEnd])

            var oldLine = 1
            var newLine = 1
            if contextStart > 0 {
                for idx in 0..<contextStart {
                    let entry = entries[idx]
                    if entry.type == .same || entry.type == .remove { oldLine += 1 }
                    if entry.type == .same || entry.type == .add { newLine += 1 }
                }
            }

            var oldCount = 0
            var newCount = 0
            for entry in hunkEntries {
                if entry.type == .same || entry.type == .remove { oldCount += 1 }
                if entry.type == .same || entry.type == .add { newCount += 1 }
            }

            hunks.append(
                DiffHunk(
                    oldStart: oldLine,
                    oldCount: oldCount,
                    newStart: newLine,
                    newCount: newCount,
                    lines: hunkEntries
                )
            )
        }
        return hunks
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
        case "schedule_create":
            return Self.schedulePreview(input: input, verb: "Create")
        case "schedule_update":
            return Self.schedulePreview(input: input, verb: "Update")
        case "schedule_delete":
            let jobId = (input["job_id"]?.value as? String) ?? ""
            return jobId.isEmpty ? "Delete schedule" : "Delete schedule \(jobId)"
        case "schedule_list":
            return "List schedules"
        case "credential_store":
            return Self.credentialPreview(input: input)
        default:
            return Self.genericPreview(toolName: toolName, input: input)
        }
    }

    /// Build a preview string for schedule_create/schedule_update tools.
    private static func schedulePreview(input: [String: AnyCodable], verb: String) -> String {
        let name = (input["name"]?.value as? String) ?? ""
        let jobId = (input["job_id"]?.value as? String) ?? ""
        let expr = (input["expression"]?.value as? String)
            ?? (input["cron_expression"]?.value as? String)
            ?? ""
        let message = (input["message"]?.value as? String) ?? ""

        var parts: [String] = []
        if !name.isEmpty { parts.append("\"\(name)\"") }
        if !jobId.isEmpty && name.isEmpty { parts.append(jobId) }
        if !expr.isEmpty { parts.append(expr) }
        if parts.isEmpty && !message.isEmpty {
            parts.append("\"\(message.count > 60 ? String(message.prefix(57)) + "..." : message)\"")
        }

        if parts.isEmpty { return "\(verb) schedule" }
        return "\(verb): \(parts.joined(separator: " — "))"
    }

    /// Build a preview string for the credential_store tool.
    private static func credentialPreview(input: [String: AnyCodable]) -> String {
        let action = (input["action"]?.value as? String) ?? ""
        let service = (input["service"]?.value as? String) ?? ""

        switch action {
        case "oauth2_connect":
            return service.isEmpty ? "Connect account" : "Connect \(service) account"
        case "store":
            return service.isEmpty ? "Save credential" : "Save \(service) credential"
        case "delete":
            return service.isEmpty ? "Remove credential" : "Remove \(service) credential"
        case "prompt":
            return service.isEmpty ? "Request credential" : "Request \(service) credential"
        default:
            return service.isEmpty ? "Access secure storage" : "\(service) credential"
        }
    }

    /// Build a generic preview from tool input, preferring known key names over
    /// arbitrary first-string-value fallback.
    private static func genericPreview(toolName: String, input: [String: AnyCodable]) -> String {
        // Prefer semantically meaningful keys over random dictionary iteration order
        let preferredKeys = ["name", "query", "message", "description", "title", "url", "path", "command", "id"]
        for key in preferredKeys {
            if let val = input[key]?.value as? String, !val.isEmpty {
                return val.count > 80 ? String(val.prefix(77)) + "..." : val
            }
        }
        // Fall back to first string value
        if let firstString = input.values.compactMap({ $0.value as? String }).first {
            return firstString.count > 80 ? String(firstString.prefix(77)) + "..." : firstString
        }
        return ""
    }

    /// User-facing tool category label (e.g. "Run Command", "Write File").
    public var toolCategory: String {
        if let override = _overrideToolCategory { return override }
        switch toolName {
        case "bash", "host_bash":                    return "Run Command"
        case "file_write", "host_file_write":        return "Write File"
        case "file_edit", "host_file_edit":           return "Edit File"
        case "file_read", "host_file_read":           return "Read File"
        case "web_fetch":                             return "Fetch URL"
        case "web_search":                            return "Web Search"
        case "credential_store":                      return "Secure Storage"
        case _ where toolName.hasPrefix("browser_"):  return "Browser"
        case _ where toolName.hasPrefix("schedule_"): return "Scheduling"
        case _ where toolName.hasPrefix("watcher_"):  return "Watcher"
        case _ where toolName.hasPrefix("memory_"):   return "Memory"
        case "skill_load":                            return "Skill"
        case "evaluate_typescript_code":              return "Code Sandbox"
        case "document_create", "document_update":    return "Document"
        default:
            return toolName
                .replacingOccurrences(of: "_", with: " ")
                .split(separator: " ")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    /// Icon for the tool category.
    public var toolCategoryIcon: VIcon {
        switch toolName {
        case "bash", "host_bash":                    return .terminal
        case "file_write", "host_file_write":        return .filePlus
        case "file_edit", "host_file_edit":           return .pencil
        case "file_read", "host_file_read":           return .fileText
        case "web_fetch":                             return .circleArrowDown
        case "web_search":                            return .search
        case "credential_store":                      return .shield
        case _ where toolName.hasPrefix("browser_"):  return .globe
        case _ where toolName.hasPrefix("schedule_"): return .calendar
        case _ where toolName.hasPrefix("watcher_"):  return .eye
        case _ where toolName.hasPrefix("memory_"):   return .brain
        case "skill_load":                            return .puzzle
        case "evaluate_typescript_code":              return .fileCode
        case "document_create", "document_update":    return .fileText
        default:                                      return .puzzle
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
        confirmationHumanDescription(
            toolName: toolName,
            input: input,
            toolCategory: toolCategory,
            permissionFriendlyName: permissionFriendlyName
        )
    }

    public init(requestId: String, toolName: String, input: [String: AnyCodable] = [:], riskLevel: String, diff: ConfirmationRequestDiff? = nil, allowlistOptions: [ConfirmationRequestAllowlistOption] = [], scopeOptions: [ConfirmationRequestScopeOption] = [], executionTarget: String? = nil, persistentDecisionsAllowed: Bool = true, temporaryOptionsAvailable: [String] = [], toolUseId: String? = nil, state: ToolConfirmationState = .pending) {
        self.requestId = requestId
        self.toolName = toolName
        self.input = input
        self.riskLevel = riskLevel
        self.diff = diff
        self.allowlistOptions = allowlistOptions
        self.scopeOptions = scopeOptions
        self.executionTarget = executionTarget
        self.persistentDecisionsAllowed = persistentDecisionsAllowed
        self.temporaryOptionsAvailable = temporaryOptionsAvailable
        self.toolUseId = toolUseId
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
        promptPayload: ToolPermissionSimulateResponsePromptPayload
    ) -> ToolConfirmationData {
        let allowlistOptions = promptPayload.allowlistOptions.map { opt in
            ConfirmationRequestAllowlistOption(
                label: opt.label,
                description: opt.description,
                pattern: opt.pattern
            )
        }
        let scopeOptions = promptPayload.scopeOptions.map { opt in
            ConfirmationRequestScopeOption(label: opt.label, scope: opt.scope)
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

/// Shared helper that builds a human-friendly confirmation description from tool
/// metadata. Used by both the inline `ToolConfirmationBubble` (via
/// `ToolConfirmationData.humanDescription`) and system notifications (via
/// `ToolConfirmationNotificationService`).
public func confirmationHumanDescription(
    toolName: String,
    input: [String: AnyCodable],
    toolCategory: String? = nil,
    permissionFriendlyName: String? = nil
) -> String {
    // Use activity (or legacy reason), falling back to description/message for
    // tools that provide context via other fields (e.g. context_overflow_compression uses description)
    let rawReason = (input["activity"]?.value as? String)
        ?? (input["reason"]?.value as? String)
        ?? ""
    let reason: String = rawReason.isEmpty
        ? (input["description"]?.value as? String)
            ?? (input["message"]?.value as? String)
            ?? ""
        : rawReason
    let r = reason.isEmpty ? "" : reason.prefix(1).lowercased() + reason.dropFirst()

    // Derive permissionFriendlyName from input when not provided
    let perm: String = permissionFriendlyName ?? {
        guard let type = input["permission_type"]?.value as? String else { return "Permission" }
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
    }()

    // Derive toolCategory from toolName when not provided
    let tc: String = toolCategory ?? {
        switch toolName {
        case "bash", "host_bash":                    return "Run Command"
        case "file_write", "host_file_write":        return "Write File"
        case "file_edit", "host_file_edit":           return "Edit File"
        case "file_read", "host_file_read":           return "Read File"
        case "web_fetch":                             return "Fetch URL"
        case "web_search":                            return "Web Search"
        case "credential_store":                      return "Secure Storage"
        case _ where toolName.hasPrefix("browser_"):  return "Browser"
        case _ where toolName.hasPrefix("schedule_"): return "Scheduling"
        case _ where toolName.hasPrefix("watcher_"):  return "Watcher"
        case _ where toolName.hasPrefix("memory_"):   return "Memory"
        case "skill_load":                            return "Skill"
        case "evaluate_typescript_code":              return "Code Sandbox"
        case "document_create", "document_update":    return "Document"
        default:
            return toolName
                .replacingOccurrences(of: "_", with: " ")
                .split(separator: " ")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }()

    switch toolName {
    case "request_system_permission":
        if reason.isEmpty {
            return "I need \(perm) access to continue."
        }
        return reason
    case "bash", "host_bash":
        if !r.isEmpty { return "Allow running a command on your computer \(r)?" }
        return "Allow running a command on your computer?"
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
    case "schedule_create":
        let name = (input["name"]?.value as? String) ?? ""
        return name.isEmpty
            ? "Allow creating a schedule?"
            : "Allow creating schedule \"\(name)\"?"
    case "schedule_update":
        return "Allow updating a schedule?"
    case "schedule_delete":
        return "Allow deleting a schedule?"
    default:
        if !r.isEmpty { return "Allow using \(tc.lowercased()) \(r)?" }
        return "Allow using \(tc.lowercased())?"
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

    /// Icon for the sub-tool type.
    public var toolIcon: VIcon {
        switch toolName.lowercased() {
        case "read", "file_read":       return .fileText
        case "edit", "file_edit":       return .pencil
        case "write", "file_write":     return .filePlus
        case "bash":                    return .terminal
        case "glob":                    return .folderSearch
        case "grep":                    return .search
        case "websearch", "web_search": return .search
        case "webfetch", "web_fetch":   return .circleArrowDown
        case "task":                    return .users
        default:                        return .puzzle
        }
    }
}

/// Data for a tool call displayed inline in an assistant message.
public struct ToolCallData: Identifiable, Equatable {
    public let id: UUID
    public let toolName: String
    public var inputSummary: String
    /// Full (untruncated) input text for display in expanded views.
    public var inputFull: String
    /// Lightweight sentinel tracking `inputFull.count` so that `==` can detect
    /// rehydration (empty -> populated) without expensive full-string comparison.
    public var inputFullLength: Int = 0
    /// Untruncated raw value of the primary input key (e.g. file path).
    /// Unlike inputSummary (truncated to 80 chars) this preserves the full value
    /// for use in file existence checks and opening files.
    public var inputRawValue: String
    /// Lightweight sentinel tracking `inputRawValue.count` so that `==` can detect
    /// rehydration (empty -> populated) without expensive full-string comparison.
    public var inputRawValueLength: Int = 0
    public var result: String?
    /// Lightweight sentinel tracking `result?.count` so that `==` can detect
    /// rehydration without expensive full-string comparison on multi-MB results.
    public var resultLength: Int = 0
    public var isError: Bool
    public var isComplete: Bool
    /// Raw decoded tool input dictionary, stored for lazy formatting of `inputFull`.
    /// When non-nil and `inputFull` is empty, the formatted string has not yet been
    /// computed — call `ToolCallData.formatAllToolInput(_:)` on demand.
    public var inputRawDict: [String: AnyCodable]?
    /// Whether this tool call arrived before any text content in the message.
    /// Used to render pre-text tool calls above and post-text tool calls below the bubble.
    public var arrivedBeforeText: Bool
    public var startedAt: Date?
    public var completedAt: Date?
    /// The tool_use block ID from the daemon, for correlating confirmations to tool calls.
    public var toolUseId: String?
    /// Persisted confirmation decision for this tool call (survives app restart / conversation switch).
    public var confirmationDecision: ToolConfirmationState?
    /// Friendly label for the confirmation (e.g. "Edit File", "Run Command").
    public var confirmationLabel: String?
    /// Base64-encoded image data from tool contentBlocks (e.g. browser_screenshot).
    public var imageData: String?
    /// Human-readable building status from app tool input (e.g. "Adding dark mode styles").
    public var buildingStatus: String?
    /// Non-technical reason for the tool call, extracted from the `reason` field of tool input.
    public var reasonDescription: String?
    /// Accumulated streaming output from tool_output_chunk events (plain text only).
    /// Capped at 5000 characters (keeps the tail when exceeded).
    public var partialOutput: String = ""
    /// Monotonically increasing revision counter so that `==` can detect
    /// changes without expensive full-string comparison. Incremented on
    /// every write, even when `partialOutput` is at the character cap.
    public var partialOutputRevision: Int = 0
    /// Live pending confirmation attached to this tool call for inline rendering.
    /// Set when a `confirmation_request` arrives, cleared when approved/denied.
    public var pendingConfirmation: ToolConfirmationData?
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
            && lhs.resultLength == rhs.resultLength
            && lhs.isError == rhs.isError
            && lhs.isComplete == rhs.isComplete
            && lhs.arrivedBeforeText == rhs.arrivedBeforeText
            // inputFull, inputRawValue, and imageData are intentionally excluded
            // from direct comparison — they can be multi-MB / 10k+ chars.
            // Instead, lightweight length sentinels detect rehydration changes
            // (empty -> populated) without expensive full-string comparison.
            && lhs.inputFullLength == rhs.inputFullLength
            && lhs.inputRawValueLength == rhs.inputRawValueLength
            && lhs.partialOutputRevision == rhs.partialOutputRevision
            && lhs.buildingStatus == rhs.buildingStatus
            && lhs.reasonDescription == rhs.reasonDescription
            && lhs.claudeCodeSteps == rhs.claudeCodeSteps
            && lhs.startedAt == rhs.startedAt
            && lhs.completedAt == rhs.completedAt
            && lhs.confirmationDecision == rhs.confirmationDecision
            && lhs.confirmationLabel == rhs.confirmationLabel
            && lhs.pendingConfirmation == rhs.pendingConfirmation
    }

    public init(id: UUID = UUID(), toolName: String, inputSummary: String, inputFull: String? = nil, inputRawValue: String? = nil, result: String? = nil, isError: Bool = false, isComplete: Bool = false, arrivedBeforeText: Bool = true, imageData: String? = nil, startedAt: Date? = nil, completedAt: Date? = nil) {
        self.id = id
        self.toolName = toolName
        self.inputSummary = inputSummary
        let fullInput = inputFull ?? inputSummary
        self.inputFull = fullInput
        self.inputFullLength = fullInput.count
        let rawValue = inputRawValue ?? inputSummary
        self.inputRawValue = rawValue
        self.inputRawValueLength = rawValue.count
        self.result = result
        self.resultLength = result?.count ?? 0
        self.isError = isError
        self.isComplete = isComplete
        self.arrivedBeforeText = arrivedBeforeText
        let decoded = Self.decodeImage(from: imageData)
        // Keep cachedImage for display, nil out raw base64 to save ~2.7MB per screenshot
        self.cachedImage = decoded
        self.imageData = decoded == nil ? imageData : nil
        self.startedAt = startedAt
        self.completedAt = completedAt
    }

    /// Decode base64 image data into a platform image. Returns nil if data is absent or invalid.
    #if os(macOS)
    public static func decodeImage(from base64String: String?) -> NSImage? {
        guard let base64String, let data = Data(base64Encoded: base64String) else { return nil }
        let start = CFAbsoluteTimeGetCurrent()
        let image = NSImage(data: data)
        let elapsed = CFAbsoluteTimeGetCurrent() - start
        if elapsed > 0.05 {
            Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ToolCallData")
                .warning("Image decode took \(String(format: "%.1f", elapsed * 1000))ms, base64 size \(base64String.count)")
        }
        return image
    }
    #elseif os(iOS)
    public static func decodeImage(from base64String: String?) -> UIImage? {
        guard let base64String, let data = Data(base64Encoded: base64String) else { return nil }
        let start = CFAbsoluteTimeGetCurrent()
        let image = UIImage(data: data)
        let elapsed = CFAbsoluteTimeGetCurrent() - start
        if elapsed > 0.05 {
            Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ToolCallData")
                .warning("Image decode took \(String(format: "%.1f", elapsed * 1000))ms, base64 size \(base64String.count)")
        }
        return image
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
        case "app_refresh", "app_update":          return "Refresh App"
        case "request_system_permission":          return "Request Permission"
        case "skill_execute":                      return "Use Skill"
        default:
            return toolName
                .replacingOccurrences(of: "_", with: " ")
                .split(separator: " ")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    /// Icon appropriate for the tool type.
    public var toolIcon: VIcon {
        switch toolName {
        case "bash", "host_bash":                  return .terminal
        case "file_write", "host_file_write":      return .filePlus
        case "file_edit", "host_file_edit":        return .pencil
        case "file_read", "host_file_read":        return .fileText
        case "glob":                               return .folderSearch
        case "grep":                               return .search
        case "web_fetch":                          return .circleArrowDown
        case "browser_navigate":                   return .globe
        case "browser_screenshot":                 return .scan
        case "browser_click":                      return .mousePointerClick
        case "browser_type":                       return .keyboard
        case "app_create", "app_refresh", "app_update": return .smartphone
        case "request_system_permission":          return .shield
        case "skill_execute":                      return .puzzle
        default:                                   return .puzzle
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
        case "app_refresh", "app_update":
            return "Refreshed the app"
        case "app_open":
            return inputSummary.isEmpty ? "Opened an app" : "Opened \(inputSummary)"
        case "request_system_permission":
            return "Requested system access"
        case "web_search":
            return inputSummary.isEmpty ? "Searched the web" : "Searched for \"\(truncated(inputSummary, to: 50))\""
        case "memory_manage":
            let op = inputRawDict?["op"]?.value as? String ?? "save"
            switch op {
            case "update": return "Updated a memory"
            case "delete": return "Deleted a memory"
            default: return "Saved a memory"
            }
        case "memory_recall":
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
        case "computer_use_done", "computer_use_respond":
            return "Finished the task"
        case "ui_show":
            return inputSummary.isEmpty ? "Showed a panel" : "Opened \(inputSummary)"
        case "ui_update":
            return "Updated the panel"
        case "ui_dismiss":
            return "Closed the panel"
        case "playbook_create":
            return "Created a playbook"
        case "playbook_update":
            return "Updated a playbook"
        case "playbook_list":
            return "Listed playbooks"
        case "skill_execute":
            return inputSummary.isEmpty ? "Used a skill" : inputSummary
        default:
            return friendlyName
        }
    }

    private func interpretBashCommand(_ cmd: String) -> String {
        // For compound commands (cd foo && claude ...), skip trivial prefix commands
        // to describe the meaningful part.
        let trivialPrefixes: Set<String> = ["cd", "pushd", "popd", "export", "source"]
        let segments = cmd.components(separatedBy: "&&").map { $0.trimmingCharacters(in: .whitespaces) }
        // Skip all leading trivial segments so "cd repo && export FOO=1 && bun test"
        // resolves to "bun test" rather than stopping after the first trivial segment.
        var remaining = segments[...]
        while remaining.count > 1,
              let firstWord = remaining.first?
                  .components(separatedBy: .whitespaces).first(where: { !$0.isEmpty }),
              trivialPrefixes.contains((firstWord as NSString).lastPathComponent.lowercased()) {
            remaining = remaining.dropFirst()
        }
        let effectiveCmd = remaining.joined(separator: " && ").trimmingCharacters(in: .whitespaces)

        let tokens = effectiveCmd.trimmingCharacters(in: .whitespaces)
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
        case "cd", "pushd", "popd":
            return target().map { "Navigated to \($0)" } ?? "Changed directory"
        case "claude":
            // Extract the prompt flag value for context
            if let pIdx = tokens.firstIndex(of: "-p"), pIdx + 1 < tokens.count {
                let prompt = tokens[(pIdx + 1)...].joined(separator: " ")
                    .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
                return truncated(prompt, to: 60)
            }
            return "Ran Claude Code"
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

    // MARK: - Lazy tool input formatting

    /// Priority list of input keys whose values are most useful as a tool call summary.
    private static let toolInputPriorityKeys = [
        "command", "file_path", "path", "query", "url", "pattern", "glob"
    ]

    /// Argument keys whose values may contain credentials and must be redacted.
    private static let sensitiveKeys: Set<String> = [
        "value", "secret", "password", "token", "client_secret", "api_key",
        "authorization", "access_token", "refresh_token", "api_secret",
        "accesstoken", "refreshtoken", "apikey", "apisecret", "clientsecret",
        "x-api-key"
    ]

    private static func isSensitiveKey(_ key: String) -> Bool {
        sensitiveKeys.contains(key.lowercased())
    }

    /// Format all tool input arguments for display in expanded details.
    /// This is a self-contained static method so views can call it without
    /// needing a ChatViewModel reference (used for lazy formatting on expand).
    public static func formatAllToolInput(_ input: [String: AnyCodable]) -> String {
        guard !input.isEmpty else { return "" }

        let primaryKey = toolInputPriorityKeys.first(where: { input[$0] != nil })
            ?? input.keys.sorted().first

        let orderedKeys: [String]
        if let pk = primaryKey {
            orderedKeys = [pk] + input.keys.filter { $0 != pk }.sorted()
        } else {
            orderedKeys = input.keys.sorted()
        }

        var lines: [String] = []
        for key in orderedKeys {
            guard let value = input[key] else { continue }
            if isSensitiveKey(key) {
                lines.append("\(key): [redacted]")
            } else {
                lines.append("\(key): \(redactingStringifyValue(value))")
            }
        }

        return lines.joined(separator: "\n")
    }

    private static func stringifyValue(_ value: AnyCodable) -> String {
        if let s = value.value as? String { return s }
        if let b = value.value as? Bool { return b ? "true" : "false" }
        if let n = value.value as? Int { return String(n) }
        if let n = value.value as? Double { return String(n) }
        if let encoder = try? JSONEncoder().encode(value),
           let json = String(data: encoder, encoding: .utf8) {
            return json
        }
        return String(describing: value.value ?? "")
    }

    private static func redactingStringifyValue(_ value: AnyCodable) -> String {
        if let dict = value.value as? [String: Any] {
            return redactDictionary(dict)
        }
        if let array = value.value as? [Any] {
            return redactArray(array)
        }
        return stringifyValue(value)
    }

    private static func redactDictionary(_ dict: [String: Any]) -> String {
        let redacted = redactDictionaryAsObject(dict)
        if let data = try? JSONSerialization.data(withJSONObject: redacted, options: [.sortedKeys]),
           let json = String(data: data, encoding: .utf8) {
            return json
        }
        return String(describing: redacted)
    }

    private static func redactArray(_ array: [Any]) -> String {
        let redacted = redactArrayAsObject(array)
        if let data = try? JSONSerialization.data(withJSONObject: redacted, options: [.sortedKeys]),
           let json = String(data: data, encoding: .utf8) {
            return json
        }
        return String(describing: redacted)
    }

    private static func redactDictionaryAsObject(_ dict: [String: Any]) -> [String: Any] {
        var redacted: [String: Any] = [:]
        for (key, val) in dict {
            if isSensitiveKey(key) {
                redacted[key] = "[redacted]"
            } else if let nested = val as? [String: Any] {
                redacted[key] = redactDictionaryAsObject(nested)
            } else if let nested = val as? [Any] {
                redacted[key] = redactArrayAsObject(nested)
            } else {
                redacted[key] = val
            }
        }
        return redacted
    }

    private static func redactArrayAsObject(_ array: [Any]) -> [Any] {
        return array.map { element -> Any in
            if let dict = element as? [String: Any] {
                return redactDictionaryAsObject(dict)
            } else if let nested = element as? [Any] {
                return redactArrayAsObject(nested)
            }
            return element
        }
    }
}

/// Lightweight reference to a surface, retaining only the fields needed to
/// re-open a workspace. Avoids keeping the full UiSurfaceShowMessage (which
/// retains the entire HTML payload) in memory.
public struct SurfaceRef: Equatable {
    public let surfaceId: String
    public let conversationId: String?
    public let surfaceType: String
    public let title: String?
    /// The real app ID from DynamicPageSurfaceData. Used for app_open_request
    /// because surfaceId is a daemon-generated identifier (e.g. "app-open-<uuid>")
    /// that doesn't match any real app.
    public let appId: String?

    public init(surfaceId: String, conversationId: String?, surfaceType: String, title: String?, appId: String? = nil) {
        self.surfaceId = surfaceId
        self.conversationId = conversationId
        self.surfaceType = surfaceType
        self.title = title
        self.appId = appId
    }

    /// Build from a UiSurfaceShowMessage + parsed Surface, discarding the heavy data payload.
    /// Extracts appId from DynamicPageSurfaceData when available.
    public init(from msg: UiSurfaceShowMessage, surface: Surface? = nil) {
        self.surfaceId = msg.surfaceId
        self.conversationId = msg.conversationId
        self.surfaceType = msg.surfaceType
        self.title = msg.title
        if let surface, case .dynamicPage(let dpData) = surface.data {
            self.appId = dpData.appId
        } else {
            self.appId = nil
        }
    }
}

/// Data for an inline UI surface rendered within a chat message.
public struct InlineSurfaceData: Identifiable, Equatable {
    public let id: String
    public let surfaceType: SurfaceType
    public let title: String?
    public var data: SurfaceData
    public var actions: [SurfaceActionButton]
    /// Lightweight reference for dynamic pages, used to re-open the workspace.
    /// Replaces the former full UiSurfaceShowMessage to avoid retaining
    /// entire HTML payloads in memory.
    public let surfaceRef: SurfaceRef?

    public static func == (lhs: InlineSurfaceData, rhs: InlineSurfaceData) -> Bool {
        lhs.id == rhs.id
            && lhs.completionState == rhs.completionState
            && lhs.surfaceType == rhs.surfaceType
            && lhs.title == rhs.title
            && lhs.data == rhs.data
            && lhs.actions == rhs.actions
    }

    /// When non-nil, the surface has been completed and should render in collapsed/chip state.
    public var completionState: SurfaceCompletionState?

    public init(id: String, surfaceType: SurfaceType, title: String?, data: SurfaceData, actions: [SurfaceActionButton], surfaceRef: SurfaceRef? = nil, completionState: SurfaceCompletionState? = nil) {
        self.id = id
        self.surfaceType = surfaceType
        self.title = title
        self.data = data
        self.actions = actions
        self.surfaceRef = surfaceRef
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
    /// Origin of the attachment on the daemon side, when known.
    public let sourceType: String?
    /// Base64-encoded file data. Empty when the attachment was too large to embed
    /// in the history_response — use ``fetchData(port:)`` to load it lazily.
    /// Mutable so it can be nil'd out after the daemon has persisted the data,
    /// keeping only the thumbnail for display.
    public var data: String
    /// Pre-rendered thumbnail for image attachments (resized to 120px max dimension).
    public let thumbnailData: Data?
    /// Pre-computed length of `data` to avoid O(n) String.count during rendering.
    /// Swift's String.count iterates the entire string to count grapheme clusters,
    /// which is expensive for multi-MB base64 strings on every SwiftUI render pass.
    /// Mutable so it can be zeroed when `data` is cleared for lazy-loadable attachments.
    public var dataLength: Int
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

    /// Absolute path to the local file on disk. Present for file-backed attachments
    /// (e.g. recordings) where the file lives on the same Mac as the client.
    public let filePath: String?

    /// Whether this attachment's binary data was omitted to keep the payload small.
    /// The client should fetch it lazily via the HTTP endpoint when the user interacts.
    public var isLazyLoad: Bool { data.isEmpty && sizeBytes != nil }

    #if os(macOS)
    public init(id: String, filename: String, mimeType: String, data: String, thumbnailData: Data?, dataLength: Int, sizeBytes: Int? = nil, thumbnailImage: NSImage?, filePath: String? = nil, sourceType: String? = nil) {
        self.id = id
        self.filename = filename
        self.mimeType = mimeType
        self.sourceType = sourceType
        self.data = data
        self.thumbnailData = thumbnailData
        self.dataLength = dataLength
        self.sizeBytes = sizeBytes
        self.thumbnailImage = thumbnailImage
        self.filePath = filePath
    }
    #elseif os(iOS)
    public init(id: String, filename: String, mimeType: String, data: String, thumbnailData: Data?, dataLength: Int, sizeBytes: Int? = nil, thumbnailImage: UIImage?, filePath: String? = nil, sourceType: String? = nil) {
        self.id = id
        self.filename = filename
        self.mimeType = mimeType
        self.sourceType = sourceType
        self.data = data
        self.thumbnailData = thumbnailData
        self.dataLength = dataLength
        self.sizeBytes = sizeBytes
        self.thumbnailImage = thumbnailImage
        self.filePath = filePath
    }
    #else
    #error("Unsupported platform")
    #endif
}

/// Tracks the state of a guardian decision prompt displayed in chat.
public enum GuardianDecisionState: Equatable {
    case pending
    case resolved(action: String)
    /// The request was already resolved by another actor or expired.
    /// `reason` carries the server-supplied explanation when available.
    case stale(reason: String? = nil)
}

/// Data for a guardian decision prompt message displayed in chat.
/// Populated from `GuardianDecisionPromptWire` returned by the daemon.
public struct GuardianDecisionData: Equatable {
    public let requestId: String
    public let requestCode: String
    public let questionText: String
    public let toolName: String?
    public let actions: [GuardianActionOption]
    public let conversationId: String
    /// Canonical request kind (e.g. "tool_approval", "pending_question").
    /// Determines UI treatment: header text, available actions, and styling.
    public let kind: String?
    public var state: GuardianDecisionState = .pending
    /// True while waiting for the server to acknowledge a button click.
    public var isSubmitting: Bool = false

    public init(requestId: String, requestCode: String, questionText: String, toolName: String?, actions: [GuardianActionOption], conversationId: String, kind: String? = nil, state: GuardianDecisionState = .pending) {
        self.requestId = requestId
        self.requestCode = requestCode
        self.questionText = questionText
        self.toolName = toolName
        self.actions = actions
        self.conversationId = conversationId
        self.kind = kind
        self.state = state
    }

    /// Build from the wire type returned by the daemon HTTP API.
    public init(from wire: GuardianDecisionPromptWire) {
        self.requestId = wire.requestId
        self.requestCode = wire.requestCode
        self.questionText = wire.questionText
        self.toolName = wire.toolName
        self.actions = wire.actions
        self.conversationId = wire.conversationId
        self.kind = wire.kind
        self.state = wire.state == "resolved" ? .stale() : .pending
    }
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

public struct ChatMessage: Identifiable, Equatable {
    // Explicit Equatable: compare only fields that affect rendering.
    // Avoids expensive byte-by-byte comparison of attachment data,
    // image payloads, and surface HTML that don't change the UI.
    public static func == (lhs: ChatMessage, rhs: ChatMessage) -> Bool {
        lhs.id == rhs.id
        && lhs.role == rhs.role
        && lhs.textSegments == rhs.textSegments
        && lhs.isStreaming == rhs.isStreaming
        && lhs.status == rhs.status
        && lhs.isError == rhs.isError
        && lhs.conversationError == rhs.conversationError
        && lhs.toolCalls == rhs.toolCalls
        && lhs.attachments.count == rhs.attachments.count
        && lhs.attachmentWarnings == rhs.attachmentWarnings
        && lhs.inlineSurfaces == rhs.inlineSurfaces
        && lhs.confirmation?.state == rhs.confirmation?.state
        && lhs.guardianDecision?.state == rhs.guardianDecision?.state
        && lhs.guardianDecision?.isSubmitting == rhs.guardianDecision?.isSubmitting
        && lhs.isSubagentNotification == rhs.isSubagentNotification
        && lhs.isContentStripped == rhs.isContentStripped
        && lhs.streamingCodePreview == rhs.streamingCodePreview
    }
    public let id: UUID
    public let role: ChatRole
    public var textSegments: [String]
    public var contentOrder: [ContentBlockRef]
    public var timestamp: Date
    public var isStreaming: Bool
    public var status: ChatMessageStatus
    /// Non-nil when this message is an inline tool confirmation request.
    public var confirmation: ToolConfirmationData?
    /// Non-nil when this message is a guardian decision prompt.
    public var guardianDecision: GuardianDecisionData?
    public var skillInvocation: SkillInvocationData?
    public var modelList: ModelListData?
    public var commandList: CommandListData?
    public var attachments: [ChatAttachment]
    public var attachmentWarnings: [String]
    public var toolCalls: [ToolCallData]
    public var inlineSurfaces: [InlineSurfaceData]
    /// Streaming code preview from tool input generation (e.g. app_create HTML).
    public var streamingCodePreview: String?
    /// Tool name associated with the streaming code preview.
    public var streamingCodeToolName: String?
    /// When true, this message represents a conversation error (rate limit, network failure, etc.)
    /// and should be rendered with distinct error styling (red box) instead of a normal bubble.
    public var isError: Bool
    /// Typed error metadata for inline error display (category icon, recovery suggestion, etc.).
    /// Populated when the error originates from a `ConversationErrorMessage`.
    public var conversationError: ConversationError?
    /// The daemon's persisted message ID, populated from history responses.
    /// Nil for freshly streamed messages that haven't been loaded from history.
    /// Used for anchoring diagnostics exports so the daemon can locate the message.
    public var daemonMessageId: String?
    /// When true, this message is a subagent notification (e.g. completed/failed/aborted)
    /// reconstructed from history. It should be hidden from the chat UI since the
    /// corresponding subagent chip conveys the same information.
    public var isSubagentNotification: Bool = false
    /// When true, this message was auto-sent by the client (e.g. bootstrap wake-up)
    /// and should not be shown to the user.
    public var isHidden: Bool = false
    /// When true, heavyweight content (tool results, large text, inputFull/inputRawDict)
    /// has been stripped from this message to reduce memory. The UI can use this flag
    /// to show a "load full content" affordance in a future milestone.
    public var isContentStripped: Bool = false
    /// When true, the message text and/or tool results were truncated by the daemon
    /// during history loading (via maxTextChars/maxToolResultChars). Full content
    /// can be fetched on demand via message_content_request.
    public var wasTruncated: Bool = false

    /// Concatenated text from all segments. Backward-compatible computed property.
    public var text: String {
        textSegments.joined(separator: "\n")
    }

    public init(id: UUID = UUID(), role: ChatRole, text: String, timestamp: Date = Date(), isStreaming: Bool = false, status: ChatMessageStatus = .sent, confirmation: ToolConfirmationData? = nil, guardianDecision: GuardianDecisionData? = nil, skillInvocation: SkillInvocationData? = nil, attachments: [ChatAttachment] = [], attachmentWarnings: [String] = [], toolCalls: [ToolCallData] = [], inlineSurfaces: [InlineSurfaceData] = [], isError: Bool = false, conversationError: ConversationError? = nil) {
        self.id = id
        self.role = role
        self.textSegments = text.isEmpty ? [] : [text]
        self.contentOrder = text.isEmpty ? [] : [.text(0)]
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.status = status
        self.confirmation = confirmation
        self.guardianDecision = guardianDecision
        self.skillInvocation = skillInvocation
        self.attachments = attachments
        self.attachmentWarnings = attachmentWarnings
        self.toolCalls = toolCalls
        self.inlineSurfaces = inlineSurfaces
        self.isError = isError
        self.conversationError = conversationError
    }

    /// Synthesize `ToolConfirmationData` entries from persisted per-tool-call confirmation data.
    /// Returns one entry per unique (toolCategory, state) pair, deduplicated.
    /// Used as a fallback when live `decidedConfirmation` is nil (e.g. after history restore).
    public func derivedConfirmationsFromToolCalls() -> [ToolConfirmationData] {
        var seen = Set<String>()
        var result: [ToolConfirmationData] = []
        for tc in toolCalls {
            guard let decision = tc.confirmationDecision else { continue }
            let label = tc.confirmationLabel ?? tc.toolName
            let key = "\(label)|\(decision)"
            guard seen.insert(key).inserted else { continue }
            var data = ToolConfirmationData(
                requestId: "",
                toolName: tc.toolName,
                riskLevel: "medium",
                state: decision
            )
            data._overrideToolCategory = tc.confirmationLabel
            result.append(data)
        }
        return result
    }

    /// Release heavyweight data (images, attachment binary data, completed surface
    /// payloads, tool results) to reduce memory pressure on old messages
    /// that are no longer visible.
    /// Text segments are preserved in full — they are lightweight compared to binary
    /// data and are needed for transcript export. Full content can be rehydrated from
    /// the daemon via message_content_request if needed.
    /// Metadata (tool names, inputSummary, inputRawValue, surface refs) is preserved for display.
    public mutating func stripHeavyContent() {
        guard !isContentStripped else { return }

        // Tool calls: clear images, results, full input, and raw dict.
        // Keep toolName, inputSummary, and inputRawValue (short one-liner) intact for display.
        for i in toolCalls.indices {
            toolCalls[i].cachedImage = nil
            toolCalls[i].imageData = nil
            toolCalls[i].result = nil
            toolCalls[i].resultLength = 0
            toolCalls[i].inputFull = ""
            toolCalls[i].inputFullLength = 0
            toolCalls[i].inputRawDict = nil
            toolCalls[i].partialOutput = ""
            toolCalls[i].partialOutputRevision = 0
        }
        for i in attachments.indices {
            attachments[i].data = ""
            attachments[i].dataLength = 0
        }
        for i in inlineSurfaces.indices {
            if inlineSurfaces[i].completionState != nil {
                // Surface is completed — clear the heavy data payload.
                // The surface can be re-fetched from the daemon if the user scrolls back.
                inlineSurfaces[i].data = .stripped
                inlineSurfaces[i].actions = []
            }
        }
        isContentStripped = true
    }
}
