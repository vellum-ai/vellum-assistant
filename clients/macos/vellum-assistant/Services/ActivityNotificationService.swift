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

    // MARK: - Private Helpers

    private func formatTitle(summary: String, steps: Int) -> String {
        let stepWord = steps == 1 ? "step" : "steps"
        return "Task completed (\(steps) \(stepWord))"
    }

    private func formatBody(toolCalls: [ToolCallData]) -> String {
        // If no tool calls, show summary
        guard !toolCalls.isEmpty else {
            return "Your task has completed successfully."
        }

        // Show first few tool names with summaries
        // Example: "Web Search: flights NYC to London, Browser Navigate, Screenshot"
        let toolDescriptions = toolCalls.prefix(3).compactMap { tc -> String? in
            // Skip tools without meaningful summaries
            if tc.inputSummary.isEmpty {
                return tc.toolName
            } else {
                return "\(tc.toolName): \(tc.inputSummary)"
            }
        }

        // Build final body
        var body = toolDescriptions.joined(separator: ", ")

        if toolCalls.count > 3 {
            let remainingCount = toolCalls.count - 3
            let toolWord = remainingCount == 1 ? "tool" : "tools"
            body += ", and \(remainingCount) more \(toolWord)"
        }

        return body.isEmpty ? "Your task has completed successfully." : body
    }
}
