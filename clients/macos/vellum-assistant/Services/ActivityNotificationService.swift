import Foundation
import UserNotifications
import AppKit
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ActivityNotificationService")

/// Protocol for sending activity completion notifications.
public protocol ActivityNotificationServiceProtocol {
    func notifySessionComplete(
        summary: String,
        steps: Int,
        toolCalls: [ToolCallData],
        sessionId: String
    ) async
}

/// Service for sending push notifications when computer-use sessions complete.
@MainActor
public final class ActivityNotificationService: ActivityNotificationServiceProtocol {
    private let settingsStore: SettingsStore

    public init(settingsStore: SettingsStore) {
        self.settingsStore = settingsStore
    }

    /// Sends a notification when a session completes.
    /// - Only sends if notifications are enabled in settings
    /// - Only sends if app is in background
    /// - Only sends if notification permissions are granted
    public func notifySessionComplete(
        summary: String,
        steps: Int,
        toolCalls: [ToolCallData],
        sessionId: String
    ) async {
        log.info("notifySessionComplete called for session \(sessionId, privacy: .public)")

        // Check if notifications enabled in settings
        guard settingsStore.activityNotificationsEnabled else {
            log.info("Notifications disabled in settings")
            return
        }

        // Check if app is in background
        let isActive = NSApp.isActive
        log.info("App isActive: \(isActive)")
        guard !isActive else {
            log.info("App is in foreground, skipping notification")
            return
        }

        // Check notification permissions
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        log.info("Notification authorization status: \(settings.authorizationStatus.rawValue)")
        guard settings.authorizationStatus == .authorized else {
            log.warning("Notification permission not granted")
            return
        }

        // Format notification content
        let content = UNMutableNotificationContent()
        content.title = formatTitle(summary: summary, steps: steps)
        content.body = formatBody(toolCalls: toolCalls)
        content.categoryIdentifier = "ACTIVITY_COMPLETE"
        content.sound = .default
        content.userInfo = ["sessionId": sessionId, "type": "activity_complete"]

        log.info("Sending notification: \(content.title, privacy: .public)")

        // Send notification
        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )

        do {
            try await center.add(request)
            log.info("Notification sent successfully")
        } catch {
            log.error("Failed to send notification: \(error.localizedDescription)")
        }
    }

    /// Sends a notification when a quick input response completes.
    /// Only sends if the app is not active and notification permissions are granted.
    public func notifyQuickInputComplete(summary: String) async {
        // Check if app is in background
        guard !NSApp.isActive else { return }

        // Check notification permissions
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized else { return }

        let content = UNMutableNotificationContent()
        // Use first line of summary, truncated
        let firstLine = summary.components(separatedBy: .newlines).first ?? summary
        let truncated = firstLine.count > 100 ? String(firstLine.prefix(100)) + "…" : firstLine
        content.title = "Vellum"
        content.body = truncated.isEmpty ? "Response complete" : truncated
        content.sound = .default
        content.userInfo = ["type": "quick_input_complete"]

        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        try? await center.add(request)
    }

    // MARK: - Private Helpers

    private func formatTitle(summary: String, steps: Int) -> String {
        // Use the summary if it's meaningful (not empty and not just "Task completed")
        let cleanSummary = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleanSummary.isEmpty && cleanSummary.lowercased() != "task completed" {
            return cleanSummary
        }

        // Fallback to step count
        let stepWord = steps == 1 ? "step" : "steps"
        return "Task completed (\(steps) \(stepWord))"
    }

    private func formatBody(toolCalls: [ToolCallData]) -> String {
        // If no tool calls, show simple completion message
        guard !toolCalls.isEmpty else {
            return "Your task has finished successfully."
        }

        // Filter and format tool calls to be user-friendly.
        // For body text, show the target detail (tool name + input) rather than the
        // reasonDescription, since the title already shows the reason. For multi-tool
        // notifications where only some have reasons, use the reason as the label.
        let isSingleWithReason = toolCalls.count == 1
            && toolCalls.first?.reasonDescription?.isEmpty == false
        let friendlyTools = toolCalls.compactMap { tc -> String? in
            // For single-tool notifications where the title already shows the reason,
            // use the target detail (friendly name + input) for the body instead
            if !isSingleWithReason, let reason = tc.reasonDescription, !reason.isEmpty {
                let capitalized = reason.prefix(1).uppercased() + reason.dropFirst()
                return String(capitalized)
            }

            // Skip technical/internal tools that aren't user-facing
            let toolName = tc.toolName.lowercased()
            if toolName.contains("bash") || toolName.contains("command") {
                // For bash commands, try to extract what was done
                if let action = extractBashAction(from: tc.inputSummary) {
                    return action
                }
                // Show the raw command if it's short enough
                if !tc.inputSummary.isEmpty && tc.inputSummary.count < 50 {
                    return "Ran command: \(tc.inputSummary)"
                }
                return "Ran command"
            }

            // Map tool names to friendly descriptions
            let friendlyName = friendlyToolName(tc.toolName)

            // Include input summary if it's short and meaningful
            if !tc.inputSummary.isEmpty && tc.inputSummary.count < 50 && !tc.inputSummary.contains("--") {
                return "\(friendlyName): \(tc.inputSummary)"
            }

            return friendlyName
        }

        // Take first 2-3 meaningful actions
        let displayTools = friendlyTools.prefix(3)

        if displayTools.isEmpty {
            return "Completed successfully"
        }

        var body = displayTools.joined(separator: ", ")

        if friendlyTools.count > 3 {
            let remaining = friendlyTools.count - 3
            body += " and \(remaining) more action\(remaining == 1 ? "" : "s")"
        }

        return body
    }

    /// Extract user-friendly action from bash command
    private func extractBashAction(from command: String) -> String? {
        // Try to extract meaningful actions from common patterns
        if command.contains("osascript") {
            // AppleScript commands
            if command.contains("activate") {
                if let app = extractAppName(from: command) {
                    return "Opened \(app)"
                }
            }
            return "Ran AppleScript"
        }

        if command.contains("open ") {
            // Handle 'open -a AppName' pattern
            if command.contains("open -a ") {
                if let app = command.components(separatedBy: "open -a ").last?.components(separatedBy: " ").first {
                    return "Opened \(app)"
                }
            }
            if let app = command.components(separatedBy: "open ").last?.components(separatedBy: " ").first {
                return "Opened \(app)"
            }
            return "Opened application"
        }

        // Skip other bash commands - they're too technical
        return nil
    }

    /// Extract application name from AppleScript command
    private func extractAppName(from command: String) -> String? {
        // Pattern: 'tell application "AppName"'
        if let range = command.range(of: #"application \"([^\"]+)\""#, options: .regularExpression) {
            let match = command[range]
            if let appRange = match.range(of: #"\"([^\"]+)\""#, options: .regularExpression) {
                let appWithQuotes = match[appRange]
                return String(appWithQuotes.dropFirst().dropLast())
            }
        }
        return nil
    }

    /// Map technical tool names to user-friendly names
    private func friendlyToolName(_ toolName: String) -> String {
        switch toolName.lowercased() {
        case "call_start":
            return "Started call"
        case "call_status":
            return "Checked call"
        case "call_end":
            return "Ended call"
        case "schedule_create":
            return "Created schedule"
        case "schedule_update":
            return "Updated schedule"
        case "schedule_delete":
            return "Deleted schedule"
        case "reminder_create":
            return "Set reminder"
        case "reminder_list":
            return "Listed reminders"
        case "reminder_cancel":
            return "Cancelled reminder"
        case let name where name.contains("write"):
            return "Created file"
        case let name where name.contains("edit"):
            return "Edited file"
        case let name where name.contains("read"):
            return "Read file"
        case let name where name.contains("search") || name.contains("find"):
            return "Searched"
        case let name where name.contains("web") || name.contains("fetch"):
            return "Visited website"
        case let name where name.contains("screenshot"):
            return "Took screenshot"
        case let name where name.contains("click"):
            return "Clicked"
        case let name where name.contains("type"):
            return "Typed text"
        default:
            return toolName.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}
