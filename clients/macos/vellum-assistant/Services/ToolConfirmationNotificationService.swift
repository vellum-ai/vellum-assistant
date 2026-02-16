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

        return await withCheckedContinuation { continuation in
            pendingRequests[message.requestId] = continuation
        }
    }

    /// Called when the user responds to a notification (Allow/Deny/Dismiss).
    public func handleResponse(requestId: String, decision: String) {
        guard let continuation = pendingRequests.removeValue(forKey: requestId) else {
            log.warning("No pending request for requestId=\(requestId, privacy: .public)")
            return
        }
        log.info("Confirmation response: requestId=\(requestId, privacy: .public), decision=\(decision, privacy: .public)")
        continuation.resume(returning: decision)
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
        let preview = commandPreview(toolName: message.toolName, input: message.input)
        if preview.count > 200 {
            return String(preview.prefix(197)) + "..."
        }
        return preview
    }

    private func toolDisplayName(_ toolName: String) -> String {
        switch toolName {
        case "file_write": return "Write File"
        case "file_edit": return "Edit File"
        case "bash": return "Run Command"
        case "web_fetch": return "Fetch URL"
        default: return toolName.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    private func commandPreview(toolName: String, input: [String: AnyCodable]) -> String {
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
            if let firstString = input.values.compactMap({ $0.value as? String }).first {
                return firstString
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
