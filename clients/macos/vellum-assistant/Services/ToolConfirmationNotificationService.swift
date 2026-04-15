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

        if let error = await UNUserNotificationCenter.current().safeAdd(request) {
            log.error("Failed to post notification: \(error.localizedDescription)")
            return Self.inlineHandledSentinel
        }

        log.info("Posted tool confirmation notification: requestId=\(message.requestId, privacy: .public), tool=\(message.toolName, privacy: .public)")

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
        let description = confirmationHumanDescription(
            toolName: message.toolName,
            input: message.input
        )
        return description.count > 200 ? String(description.prefix(197)) + "..." : description
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

}
