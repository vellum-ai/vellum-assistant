import Foundation
import UserNotifications
import os
import VellumAssistantShared

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "ToolConfirmationNotification")

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
        content.userInfo = [
            "requestId": message.requestId,
            "type": "tool_confirmation"
        ]

        // Attach app icon
        if let attachment = createAppIconAttachment() {
            content.attachments = [attachment]
        }

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
            return "deny"
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
        let toolName = toolDisplayName(message.toolName)
        var title = "\(toolName) — \(message.riskLevel) risk"
        if let target = message.executionTarget, !target.isEmpty {
            title += " (\(target))"
        }
        return title
    }

    private func formatBody(_ message: ConfirmationRequestMessage) -> String {
        // For shell commands, show both the human-readable reason and the raw command
        if message.toolName == "bash" || message.toolName == "host_bash" {
            let command = commandPreview(toolName: message.toolName, input: message.input)
            if let reason = message.input["reason"]?.value as? String, !reason.isEmpty {
                let capitalizedReason = reason.prefix(1).uppercased() + reason.dropFirst()
                // Don't append a dangling "$ " when command is empty
                guard !command.isEmpty else {
                    return capitalizedReason.count > 200 ? String(capitalizedReason.prefix(197)) + "..." : capitalizedReason
                }
                let commandLine = "$ \(command)"
                let body = "\(capitalizedReason)\n\(commandLine)"
                if body.count <= 200 { return body }
                // Truncate reason first to preserve the command
                let commandBudget = min(commandLine.count, 200)
                let reasonBudget = 200 - commandBudget - 1 // 1 for newline
                if reasonBudget >= 4 {
                    let truncatedReason = String(capitalizedReason.prefix(reasonBudget - 3)) + "..."
                    let truncatedBody = "\(truncatedReason)\n\(commandLine)"
                    if truncatedBody.count <= 200 { return truncatedBody }
                }
                // Command alone exceeds the limit — truncate it
                return commandLine.count > 200 ? String(commandLine.prefix(197)) + "..." : commandLine
            }
            return command.count > 200 ? String(command.prefix(197)) + "..." : command
        }
        let preview = commandPreview(toolName: message.toolName, input: message.input)
        if preview.count > 200 {
            return String(preview.prefix(197)) + "..."
        }
        return preview
    }

    private func toolDisplayName(_ toolName: String) -> String {
        switch toolName {
        case "file_write":      return "Write File"
        case "file_edit":       return "Edit File"
        case "bash", "host_bash": return "Run Command"
        case "web_fetch":       return "Fetch URL"
        case "schedule_create": return "Create Schedule"
        case "schedule_update": return "Update Schedule"
        case "schedule_delete": return "Delete Schedule"
        case "schedule_list":   return "List Schedules"
        default: return toolName.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    private func commandPreview(toolName: String, input: [String: AnyCodable]) -> String {
        switch toolName {
        case "bash", "host_bash":
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
        case "schedule_create", "schedule_update":
            let verb = toolName == "schedule_create" ? "Create" : "Update"
            let name = (input["name"]?.value as? String) ?? ""
            let jobId = (input["job_id"]?.value as? String) ?? ""
            let expr = (input["expression"]?.value as? String)
                ?? (input["cron_expression"]?.value as? String) ?? ""
            let message = (input["message"]?.value as? String) ?? ""
            var parts: [String] = []
            if !name.isEmpty { parts.append("\"\(name)\"") }
            if !jobId.isEmpty && name.isEmpty { parts.append(jobId) }
            if !expr.isEmpty { parts.append(expr) }
            if parts.isEmpty && !message.isEmpty {
                let truncated = message.count > 60 ? String(message.prefix(57)) + "..." : message
                parts.append("\"\(truncated)\"")
            }
            return parts.isEmpty ? "\(verb) schedule" : "\(verb): \(parts.joined(separator: " — "))"
        case "schedule_delete":
            return (input["job_id"]?.value as? String) ?? "schedule"
        default:
            // Prefer semantically meaningful keys over arbitrary dictionary order
            let preferredKeys = ["name", "query", "message", "description", "title", "url", "path", "command", "id"]
            for key in preferredKeys {
                if let val = input[key]?.value as? String, !val.isEmpty {
                    return val.count > 80 ? String(val.prefix(77)) + "..." : val
                }
            }
            if let firstString = input.values.compactMap({ $0.value as? String }).first {
                return firstString.count > 80 ? String(firstString.prefix(77)) + "..." : firstString
            }
            return ""
        }
    }

    private func createAppIconAttachment() -> UNNotificationAttachment? {
        // Find the app icon in the bundle resources
        guard let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns") else {
            // Try to find in the resource bundle
            let resourceBundle = Bundle(identifier: "com.vellum.vellum-assistant")
            guard let bundleIconURL = resourceBundle?.url(forResource: "AppIcon", withExtension: "icns") else {
                return nil
            }
            return try? UNNotificationAttachment(identifier: "app-icon", url: bundleIconURL, options: nil)
        }
        return try? UNNotificationAttachment(identifier: "app-icon", url: iconURL, options: nil)
    }
}
