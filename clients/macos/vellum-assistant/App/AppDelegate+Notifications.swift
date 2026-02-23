import AppKit
import UserNotifications
import CoreText
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

        center.setNotificationCategories([activityCategory, toolConfirmationCategory, rideShotgunCategory, voiceResponseCategory])
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
