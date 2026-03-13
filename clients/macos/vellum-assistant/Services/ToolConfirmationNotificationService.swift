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
        var title = "Permission Required: \(toolName) — \(message.riskLevel) risk"
        if let target = message.executionTarget, !target.isEmpty {
            title += " (\(target))"
        }
        return title
    }

    private func formatBody(_ message: ConfirmationRequestMessage) -> String {
        if let reason = confirmationReasonDescription(input: message.input) {
            return reason.count > 200 ? String(reason.prefix(197)) + "..." : reason
        }
        // Provide contextual detail from tool input (command, path, URL) so the
        // notification body adds information beyond the title.
        let body = notificationBodyDetail(toolName: message.toolName, input: message.input)
        return body.count > 200 ? String(body.prefix(197)) + "..." : body
    }

    /// Extracts a contextual detail string from tool input for notification bodies.
    /// Provides specifics (command text, file path, URL) that complement the title.
    private func notificationBodyDetail(toolName: String, input: [String: AnyCodable]) -> String {
        switch toolName {
        case "bash", "host_bash":
            if let cmd = input["command"]?.value as? String {
                return cmd
            }
        case "file_write", "host_file_write", "file_edit", "host_file_edit", "file_read", "host_file_read":
            if let path = input["path"]?.value as? String {
                return path
            }
        case "web_fetch":
            if let url = input["url"]?.value as? String {
                return url
            }
        case "browser_navigate":
            if let url = input["url"]?.value as? String {
                return url
            }
        case "credential_store":
            if let service = input["service"]?.value as? String {
                return service
            }
        default:
            break
        }
        return "Approve or deny this action."
    }

    private func toolDisplayName(_ toolName: String) -> String {
        switch toolName {
        case "file_write", "host_file_write":   return "Write File"
        case "file_edit", "host_file_edit":     return "Edit File"
        case "file_read", "host_file_read":     return "Read File"
        case "bash", "host_bash":               return "Run Command"
        case "web_fetch":                       return "Fetch URL"
        case "web_search":                      return "Web Search"
        case "schedule_create":                 return "Create Schedule"
        case "schedule_update":                 return "Update Schedule"
        case "schedule_delete":                 return "Delete Schedule"
        case "schedule_list":                   return "List Schedules"
        default: return toolName.replacingOccurrences(of: "_", with: " ").capitalized
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
