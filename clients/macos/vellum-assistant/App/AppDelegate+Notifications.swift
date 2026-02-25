import AppKit
import UserNotifications
import CoreText
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate+Notifications")

extension AppDelegate {

    // MARK: - Notifications

    func setupNotifications() {

        let center = UNUserNotificationCenter.current()
        center.delegate = self

        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let error {
                log.error("Notification authorization error: \(error.localizedDescription)")
            }
        }

        let viewAction = UNNotificationAction(
            identifier: "VIEW_ACTIVITY",
            title: "View Results",
            options: .foreground
        )
        let activityCategory = UNNotificationCategory(
            identifier: "ACTIVITY_COMPLETE",
            actions: [viewAction],
            intentIdentifiers: [],
            options: []
        )

        let confirmAllowAction = UNNotificationAction(
            identifier: "CONFIRM_ALLOW",
            title: "Allow",
            options: []
        )
        let confirmDenyAction = UNNotificationAction(
            identifier: "CONFIRM_DENY",
            title: "Deny",
            options: []
        )
        let toolConfirmationCategory = UNNotificationCategory(
            identifier: "TOOL_CONFIRMATION",
            actions: [confirmAllowAction, confirmDenyAction],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )

        // Ride Shotgun invitation — duration choices
        let shotgun1Action = UNNotificationAction(identifier: "SHOTGUN_1MIN", title: "1 min", options: [])
        let shotgun3Action = UNNotificationAction(identifier: "SHOTGUN_3MIN", title: "3 min", options: [])
        let shotgun5Action = UNNotificationAction(identifier: "SHOTGUN_5MIN", title: "5 min", options: [])
        let rideShotgunCategory = UNNotificationCategory(
            identifier: "RIDE_SHOTGUN",
            actions: [shotgun1Action, shotgun3Action, shotgun5Action],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )

        let viewResponseAction = UNNotificationAction(
            identifier: "VIEW_RESPONSE",
            title: "View Response",
            options: .foreground
        )
        let voiceResponseCategory = UNNotificationCategory(
            identifier: "VOICE_RESPONSE_COMPLETE",
            actions: [viewResponseAction],
            intentIdentifiers: [],
            options: []
        )

        let viewNotificationIntentAction = UNNotificationAction(
            identifier: "VIEW_NOTIFICATION_INTENT",
            title: "View",
            options: [.foreground]
        )
        let notificationIntentCategory = UNNotificationCategory(
            identifier: "NOTIFICATION_INTENT",
            actions: [viewNotificationIntentAction],
            intentIdentifiers: [],
            options: []
        )

        center.setNotificationCategories([
            activityCategory,
            toolConfirmationCategory,
            rideShotgunCategory,
            voiceResponseCategory,
            notificationIntentCategory,
        ])
    }

    private func normalizeNotificationUserInfoValue(_ value: Any?) -> Any? {
        switch value {
        case nil:
            return nil
        case let v as String:
            return v
        case let v as Int:
            return v
        case let v as Double:
            return v
        case let v as Bool:
            return v
        case let v as [Any]:
            return v.compactMap { normalizeNotificationUserInfoValue($0) }
        case let v as [Any?]:
            return v.compactMap { normalizeNotificationUserInfoValue($0) }
        case let v as [String: Any]:
            var out: [String: Any] = [:]
            for (k, item) in v {
                if let normalized = normalizeNotificationUserInfoValue(item) {
                    out[k] = normalized
                }
            }
            return out
        case let v as [String: Any?]:
            var out: [String: Any] = [:]
            for (k, item) in v {
                if let normalized = normalizeNotificationUserInfoValue(item) {
                    out[k] = normalized
                }
            }
            return out
        default:
            guard let value else { return nil }
            return String(describing: value)
        }
    }

    func deliverNotificationIntent(_ msg: NotificationIntentMessage) {
        let content = UNMutableNotificationContent()
        content.title = msg.title
        content.body = msg.body
        content.sound = .default
        content.categoryIdentifier = "NOTIFICATION_INTENT"

        var userInfo: [String: Any] = [
            "sourceEventName": msg.sourceEventName,
        ]
        if let metadata = msg.deepLinkMetadata {
            for (key, wrapped) in metadata {
                // Keep sourceEventName authoritative from the daemon envelope.
                if key == "sourceEventName" {
                    continue
                }
                if let normalized = normalizeNotificationUserInfoValue(wrapped.value) {
                    userInfo[key] = normalized
                }
            }
        }
        content.userInfo = userInfo

        let request = UNNotificationRequest(
            identifier: "notification-intent-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                log.error("Failed to post notification intent: \(error.localizedDescription)")
            }
        }
    }

    func registerBundledFonts() {
        for name in ["Silkscreen-Regular", "Silkscreen-Bold", "DMMono-Regular", "DMMono-Medium", "Inter-Regular", "Inter-Medium", "Inter-SemiBold", "CrimsonPro-Variable", "Fraunces-Variable"] {
            guard let url = ResourceBundle.bundle.url(forResource: name, withExtension: "ttf") else {
                log.warning("Font file \(name).ttf not found in bundle")
                continue
            }
            var error: Unmanaged<CFError>?
            if !CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
                log.warning("Failed to register font \(name): \(error?.takeRetainedValue().localizedDescription ?? "unknown")")
            }
        }
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension AppDelegate: UNUserNotificationCenterDelegate {
    nonisolated public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    nonisolated public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let categoryId = response.notification.request.content.categoryIdentifier

        // Handle activity completion notifications
        if categoryId == "ACTIVITY_COMPLETE" {
            await MainActor.run {
                guard !self.isAwaitingFirstLaunchReady else { return }
                self.showMainWindow()
            }
            return
        }

        // Handle tool confirmation notifications
        if categoryId == "TOOL_CONFIRMATION" {
            let requestId = response.notification.request.content.userInfo["requestId"] as? String ?? ""
            let decision: String
            switch response.actionIdentifier {
            case "CONFIRM_ALLOW":
                decision = "allow"
            case "CONFIRM_DENY":
                decision = "deny"
            case UNNotificationDismissActionIdentifier:
                decision = "deny"
            default:
                // Default action (clicked banner) — deny and bring app forward
                decision = "deny"
                await MainActor.run {
                    guard !self.isAwaitingFirstLaunchReady else { return }
                    self.showMainWindow()
                }
            }
            await MainActor.run {
                self.toolConfirmationNotificationService.handleResponse(requestId: requestId, decision: decision)
            }
            return
        }

        // Handle voice response complete notifications
        if categoryId == "VOICE_RESPONSE_COMPLETE" {
            await MainActor.run {
                guard !self.isAwaitingFirstLaunchReady else { return }
                self.showMainWindow()
            }
            return
        }

        if categoryId == "NOTIFICATION_INTENT" {
            let conversationId =
                response.notification.request.content.userInfo["conversationId"] as? String ??
                response.notification.request.content.userInfo["conversation_id"] as? String
            await MainActor.run {
                guard !self.isAwaitingFirstLaunchReady else { return }
                if let conversationId {
                    self.openConversationThread(conversationId: conversationId)
                } else {
                    self.showMainWindow()
                }
            }
            return
        }

        // Handle ride shotgun invitation notifications
        if categoryId == "RIDE_SHOTGUN" {
            let durationSeconds: Int?
            switch response.actionIdentifier {
            case "SHOTGUN_1MIN":
                durationSeconds = 60
            case "SHOTGUN_3MIN":
                durationSeconds = 180
            case "SHOTGUN_5MIN":
                durationSeconds = 300
            case UNNotificationDismissActionIdentifier:
                durationSeconds = nil
            default:
                // Clicked the banner itself — start with default 3 min
                durationSeconds = 180
            }
            await MainActor.run {
                if let durationSeconds {
                    self.ambientAgent.startRideShotgun(durationSeconds: durationSeconds)
                } else {
                    self.ambientAgent.rideShotgunTrigger.recordDeclined()
                }
            }
            return
        }
    }
}
