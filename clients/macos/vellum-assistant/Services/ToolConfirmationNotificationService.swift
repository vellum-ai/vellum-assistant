import Foundation
import UserNotifications
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ToolConfirmationNotification")

/// Service for showing tool confirmation requests as native macOS notifications.
@MainActor
public final class ToolConfirmationNotificationService {

    private var pendingRequests: [String: CheckedContinuation<String, Never>] = [:]

    /// Shows a native notification for a tool confirmation request and awaits the user's response.
    /// Returns "allow" or "deny".
    public func showConfirmation(_ message: ConfirmationRequestMessage) async -> String {
        let content = UNMutableNotificationContent()
        content.title = formatTitle(message)
        content.body = formatBody(message)
        content.categoryIdentifier = "TOOL_CONFIRMATION"
        content.sound = .default
        var userInfo: [String: Any] = [
            "requestId": message.requestId,
            "type": "tool_confirmation"
        ]
        if let conversationId = message.conversationId {
            userInfo["conversationId"] = conversationId
        }
        content.userInfo = userInfo

        content.attachAppIcon()

        let request = UNNotificationRequest(
            identifier: "tool-confirm-\(message.requestId)",
            content: content,
            trigger: nil
        )

        do {
            try await UNUserNotificationCenter.current().add(request)
            log.info("Posted tool confirmation notification: requestId=\(message.requestId, privacy: .public), tool=\(message.toolName, privacy: .public)")
        } catch {
            log.error("Failed to post notification: \(error.localizedDescription)")
            return Self.inlineHandledSentinel
        }

        // If a continuation already exists for this requestId (e.g. daemon re-sent
        // the request), resume it with "deny" to avoid a leaked continuation crash.
        if let existing = pendingRequests.removeValue(forKey: message.requestId) {
            log.warning("Duplicate requestId=\(message.requestId, privacy: .public), denying previous")
            existing.resume(returning: "deny")
        }

        return await withCheckedContinuation { continuation in
            pendingRequests[message.requestId] = continuation
        }
    }

    /// Sentinel value returned by `showConfirmation` when the inline chat path
    /// already forwarded the response to the daemon. Callers should skip their
    /// own `sendConfirmationResponse` when they receive this value.
    public static let inlineHandledSentinel = "__inline_handled__"

    /// Called when the user responds to a notification (Allow/Deny/Dismiss).
    public func handleResponse(requestId: String, decision: String) {
        guard let continuation = pendingRequests.removeValue(forKey: requestId) else {
            log.warning("No pending request for requestId=\(requestId, privacy: .public)")
            return
        }
        log.info("Confirmation response: requestId=\(requestId, privacy: .public), decision=\(decision, privacy: .public)")
        continuation.resume(returning: decision)
    }

    /// Called when the inline chat path already sent the confirmation response
    /// to the daemon. Resumes the continuation with a sentinel so that
    /// `setupToolConfirmationNotifications` skips the duplicate send.
    public func handleInlineResponse(requestId: String) {
        guard let continuation = pendingRequests.removeValue(forKey: requestId) else {
            log.warning("No pending request for inline response: requestId=\(requestId, privacy: .public)")
            return
        }
        log.info("Inline confirmation handled: requestId=\(requestId, privacy: .public)")
        continuation.resume(returning: Self.inlineHandledSentinel)
    }

    /// Called when a notification is dismissed without action — defaults to deny.
    public func handleDismissal(requestId: String) {
        handleResponse(requestId: requestId, decision: "deny")
    }

    /// Dismiss all pending requests (e.g., on app quit).
    public func dismissAll() {
        for (requestId, continuation) in pendingRequests {
            log.info("Dismissing pending confirmation: requestId=\(requestId, privacy: .public)")
            continuation.resume(returning: "deny")
        }
        pendingRequests.removeAll()
    }

    // MARK: - Private

    private func formatTitle(_ message: ConfirmationRequestMessage) -> String {
        let action = toolHumanAction(message.toolName, input: message.input)
        if let target = message.executionTarget, !target.isEmpty {
            return "Permission Required: \(action) on \(target)"
        }
        return "Permission Required: \(action)"
    }

    private func formatBody(_ message: ConfirmationRequestMessage) -> String {
        let rawReason = (message.input["reason"]?.value as? String) ?? ""
        let reason: String = rawReason.isEmpty
            ? (message.input["description"]?.value as? String)
                ?? (message.input["message"]?.value as? String)
                ?? ""
            : rawReason

        if reason.isEmpty {
            return toolHumanFallbackBody(message.toolName, input: message.input)
        }

        let capitalized = reason.prefix(1).uppercased() + reason.dropFirst()
        let body = "Reason: \(capitalized)"
        return body.count > 200 ? String(body.prefix(197)) + "..." : body
    }

    /// Returns a short, non-technical description of what the tool wants to do.
    private func toolHumanAction(_ toolName: String, input: [String: AnyCodable]) -> String {
        switch toolName {
        case "file_write", "host_file_write":
            if let path = input["path"]?.value as? String, !path.isEmpty {
                return "Save to \(URL(fileURLWithPath: path).lastPathComponent)"
            }
            return "Save a file"
        case "file_edit", "host_file_edit":
            if let path = input["path"]?.value as? String, !path.isEmpty {
                return "Edit \(URL(fileURLWithPath: path).lastPathComponent)"
            }
            return "Edit a file"
        case "file_read", "host_file_read":
            if let path = input["path"]?.value as? String, !path.isEmpty {
                return "Read \(URL(fileURLWithPath: path).lastPathComponent)"
            }
            return "Read a file"
        case "bash", "host_bash":
            return "Run a command"
        case "web_fetch":
            if let url = input["url"]?.value as? String, let host = URL(string: url)?.host {
                return "Fetch data from \(host)"
            }
            return "Fetch a webpage"
        case "web_search":
            return "Search the web"
        case "browser_navigate":
            if let url = input["url"]?.value as? String, let host = URL(string: url)?.host {
                return "Open \(host)"
            }
            return "Open a webpage"
        case "credential_store":
            let action = (input["action"]?.value as? String) ?? ""
            let service = (input["service"]?.value as? String) ?? ""
            switch action {
            case "oauth2_connect":
                return service.isEmpty ? "Connect an account" : "Connect your \(service.capitalized) account"
            case "store":
                return service.isEmpty ? "Save a credential" : "Save a \(service) credential"
            case "delete":
                return service.isEmpty ? "Remove a credential" : "Remove a \(service) credential"
            default:
                return "Access secure storage"
            }
        case "schedule_create":
            if let name = input["name"]?.value as? String, !name.isEmpty {
                return "Create schedule \"\(name)\""
            }
            return "Create a schedule"
        case "schedule_update": return "Update a schedule"
        case "schedule_delete": return "Delete a schedule"
        case "schedule_list":   return "View schedules"
        case "request_system_permission":
            let perm = permissionDisplayName(input)
            return "Use \(perm)"
        default:
            return toolName
                .replacingOccurrences(of: "host_", with: "")
                .replacingOccurrences(of: "_", with: " ")
                .capitalized
        }
    }

    /// Fallback body when no reason is provided by the tool.
    private func toolHumanFallbackBody(_ toolName: String, input: [String: AnyCodable]) -> String {
        switch toolName {
        case "bash", "host_bash":
            if let cmd = input["command"]?.value as? String, !cmd.isEmpty {
                let truncated = cmd.count > 150 ? String(cmd.prefix(147)) + "..." : cmd
                return "Command: \(truncated)"
            }
            return "Vellum wants to run a command on your computer."
        case "file_write", "host_file_write":
            if let path = input["path"]?.value as? String, !path.isEmpty {
                return "Vellum wants to save changes to \(URL(fileURLWithPath: path).lastPathComponent)."
            }
            return "Vellum wants to save a file."
        case "file_edit", "host_file_edit":
            if let path = input["path"]?.value as? String, !path.isEmpty {
                return "Vellum wants to make changes to \(URL(fileURLWithPath: path).lastPathComponent)."
            }
            return "Vellum wants to edit a file."
        case "request_system_permission":
            let perm = permissionDisplayName(input)
            return "Vellum needs \(perm) access to continue."
        default:
            return "Vellum is asking for your permission to continue."
        }
    }

    private func permissionDisplayName(_ input: [String: AnyCodable]) -> String {
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
    }

}
