import Foundation
import UniformTypeIdentifiers
import UserNotifications
import os
import VellumAssistantShared

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "ToolConfirmationNotification")

/// Service for showing tool confirmation requests as native macOS notifications.
@MainActor
public final class ToolConfirmationNotificationService {

    private let notificationIconProvider: NotificationIconProviding
    private var pendingRequests: [String: CheckedContinuation<String, Never>] = [:]

    public init(notificationIconProvider: NotificationIconProviding) {
        self.notificationIconProvider = notificationIconProvider
    }

    // MARK: - Readiness Gate

    /// Whether this service is ready to post notifications (e.g. avatar icon exported).
    /// Callers of `showConfirmation` will transparently wait until ready.
    private var isReady = false

    /// Continuations waiting for the service to become ready.
    private var readinessWaiters: [CheckedContinuation<Void, Never>] = []

    /// Marks the service as ready and resumes any callers waiting on readiness.
    public func markReady() {
        guard !isReady else { return }
        isReady = true
        let waiters = readinessWaiters
        readinessWaiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
    }

    /// Suspends the caller until the service is ready. Returns immediately if already ready.
    private func waitUntilReady() async {
        guard !isReady else { return }
        await withCheckedContinuation { continuation in
            readinessWaiters.append(continuation)
        }
    }

    /// Shows a native notification for a tool confirmation request and awaits the user's response.
    /// Returns "allow" or "deny".
    public func showConfirmation(_ message: ConfirmationRequestMessage) async -> String {
        await waitUntilReady()
        let content = UNMutableNotificationContent()
        content.title = formatTitle(message)
        content.body = formatBody(message)
        content.categoryIdentifier = "TOOL_CONFIRMATION"
        content.sound = .default
        content.userInfo = [
            "requestId": message.requestId,
            "type": "tool_confirmation"
        ]

        // Attach assistant avatar icon
        let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") ?? ""
        if let iconURL = notificationIconProvider.notificationIconURL(for: assistantId),
           let attachment = try? UNNotificationAttachment(
               identifier: "assistant-avatar",
               url: iconURL,
               options: [UNNotificationAttachmentOptionsTypeHintKey: UTType.png.identifier]
           ) {
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
