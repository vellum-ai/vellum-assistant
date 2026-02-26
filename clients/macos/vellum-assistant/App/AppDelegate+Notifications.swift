import AppKit
import UserNotifications
import CoreText
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate+Notifications")
private let fallbackDedupWindowMs: Double = 30_000
private let fallbackDelayNs: UInt64 = 750_000_000
private let notificationPermissionToastCooldownMs: Double = 30_000

extension AppDelegate {

    // MARK: - Notifications

    func setupNotifications() {

        let center = UNUserNotificationCenter.current()
        center.delegate = self

        requestNotificationAuthorization(trigger: "app_launch", showDeniedToast: false)

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
            options: [.customDismissAction]
        )

        center.setNotificationCategories([
            activityCategory,
            toolConfirmationCategory,
            rideShotgunCategory,
            voiceResponseCategory,
            notificationIntentCategory,
        ])
    }

    /// Handles notification permission when a notification thread arrives while
    /// the app is active. This provides user-visible context for the OS prompt
    /// and gives an immediate recovery path when the app is already denied.
    func maybePromptNotificationAuthorizationForThreadCreated() {
        Task { @MainActor in
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                return
            case .notDetermined:
                guard !hasRequestedNotificationAuthorizationFromThreadSignal else { return }
                hasRequestedNotificationAuthorizationFromThreadSignal = true
                log.info("Requesting notification authorization from notification_thread_created signal")
                requestNotificationAuthorization(trigger: "notification_thread_created", showDeniedToast: true)
            case .denied:
                showNotificationPermissionSettingsToastIfNeeded()
            @unknown default:
                return
            }
        }
    }

    private func requestNotificationAuthorization(trigger: String, showDeniedToast: Bool) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            if granted {
                log.info("Notification authorization granted (\(trigger))")
                return
            }

            log.warning("Notification authorization denied (\(trigger), error: \(error?.localizedDescription ?? "none"))")
            guard showDeniedToast else { return }

            Task { @MainActor in
                self.showNotificationPermissionSettingsToastIfNeeded()
            }
        }
    }

    private func showNotificationPermissionSettingsToastIfNeeded() {
        let nowMs = Date().timeIntervalSince1970 * 1000
        guard nowMs - lastNotificationPermissionToastAtMs > notificationPermissionToastCooldownMs else { return }
        lastNotificationPermissionToastAtMs = nowMs

        mainWindow?.windowState.showToast(
            message: "Notifications are off for Vellum. Turn them on in System Settings to receive banners.",
            style: .warning,
            primaryAction: VToastAction(label: "Open Settings") { [weak self] in
                self?.openNotificationSettings()
            }
        )
    }

    private func openNotificationSettings() {
        let candidates = [
            "x-apple.systempreferences:com.apple.preference.notifications?id=\(Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant")",
            "x-apple.systempreferences:com.apple.preference.notifications",
        ]
        for candidate in candidates {
            guard let url = URL(string: candidate) else { continue }
            if NSWorkspace.shared.open(url) {
                return
            }
        }
        log.warning("Failed to open macOS Notification settings URL")
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

    private func conversationId(from deepLinkMetadata: [String: AnyCodable]?) -> String? {
        if let direct = deepLinkMetadata?["conversationId"]?.value as? String {
            return direct
        }
        if let snake = deepLinkMetadata?["conversation_id"]?.value as? String {
            return snake
        }
        return nil
    }

    private func pruneFallbackMarkers(nowMs: Double) {
        fallbackDeliveredAtMs = fallbackDeliveredAtMs.filter { _, deliveredAt in
            nowMs - deliveredAt <= fallbackDedupWindowMs
        }
    }

    /// Check notification authorization before posting. Returns true if
    /// notifications are authorized and can be delivered.
    private func checkNotificationAuthorization() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return true
        case .denied:
            log.warning("Notification authorization status is denied — skipping notification post")
            if NSApp.isActive {
                showNotificationPermissionSettingsToastIfNeeded()
            }
            return false
        case .notDetermined:
            log.info("Notification authorization status is notDetermined — attempting post anyway")
            return true
        @unknown default:
            log.warning("Notification authorization status is unknown (\(settings.authorizationStatus.rawValue)) — skipping notification post")
            return false
        }
    }

    private func postNotificationIntent(
        sourceEventName: String,
        title: String,
        body: String,
        deepLinkMetadata: [String: AnyCodable]?,
        deliveryId: String? = nil
    ) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.categoryIdentifier = "NOTIFICATION_INTENT"

        var userInfo: [String: Any] = [
            "sourceEventName": sourceEventName,
        ]
        if let deliveryId {
            userInfo["deliveryId"] = deliveryId
        }
        if let metadata = deepLinkMetadata {
            for (key, wrapped) in metadata {
                // Keep sourceEventName authoritative from the envelope.
                if key == "sourceEventName" {
                    continue
                }
                if let normalized = normalizeNotificationUserInfoValue(wrapped.value) {
                    userInfo[key] = normalized
                }
            }
        }
        content.userInfo = userInfo

        let notificationId = "notification-intent-\(UUID().uuidString)"
        let request = UNNotificationRequest(
            identifier: notificationId,
            content: content,
            trigger: nil
        )

        Task {
            let authorized = await checkNotificationAuthorization()
            guard authorized else {
                self.sendNotificationIntentResult(
                    deliveryId: deliveryId,
                    success: false,
                    errorMessage: "Notification authorization denied",
                    errorCode: "authorization_denied"
                )
                return
            }

            do {
                try await UNUserNotificationCenter.current().add(request)
                self.sendNotificationIntentResult(
                    deliveryId: deliveryId,
                    success: true,
                    errorMessage: nil,
                    errorCode: nil
                )
            } catch {
                log.error("Failed to post notification intent (id: \(notificationId), source: \(sourceEventName)): \(error.localizedDescription)")
                self.sendNotificationIntentResult(
                    deliveryId: deliveryId,
                    success: false,
                    errorMessage: error.localizedDescription,
                    errorCode: nil
                )
            }
        }
    }

    /// Send a `notification_intent_result` ack back to the daemon.
    private func sendNotificationIntentResult(
        deliveryId: String?,
        success: Bool,
        errorMessage: String?,
        errorCode: String?
    ) {
        guard let deliveryId else { return }
        let result = IPCNotificationIntentResult(
            type: "notification_intent_result",
            deliveryId: deliveryId,
            success: success,
            errorMessage: errorMessage,
            errorCode: errorCode
        )
        do {
            try daemonClient.send(result)
        } catch {
            log.warning("Failed to send notification_intent_result for deliveryId \(deliveryId): \(error.localizedDescription)")
        }
    }

    func deliverNotificationIntent(_ msg: NotificationIntentMessage) {
        let nowMs = Date().timeIntervalSince1970 * 1000
        pruneFallbackMarkers(nowMs: nowMs)

        if let conversationId = conversationId(from: msg.deepLinkMetadata) {
            // If we already posted the fallback alert for this conversation,
            // suppress the later notification_intent duplicate.
            if let deliveredAt = fallbackDeliveredAtMs.removeValue(forKey: conversationId),
               nowMs - deliveredAt <= fallbackDedupWindowMs {
                log.info("Suppressing duplicate notification_intent for conversation \(conversationId) (fallback already delivered)")
                // Ack the suppressed intent so the delivery audit trail is complete
                if let deliveryId = msg.deliveryId {
                    sendNotificationIntentResult(deliveryId: deliveryId, success: true, errorMessage: nil, errorCode: nil)
                }
                return
            }

            // notification_intent arrived in time; invalidate pending fallback.
            pendingFallbackNotifications.removeValue(forKey: conversationId)
        }

        postNotificationIntent(
            sourceEventName: msg.sourceEventName,
            title: msg.title,
            body: msg.body,
            deepLinkMetadata: msg.deepLinkMetadata,
            deliveryId: msg.deliveryId
        )
    }

    /// Schedules a fallback local notification for any notification_thread_created
    /// event. If the corresponding notification_intent IPC arrives within the
    /// delay window, the fallback is cancelled (preventing duplicates). Guardian
    /// questions use a specific body; all other event types use a generic body.
    func scheduleNotificationFallback(
        conversationId: String,
        title: String,
        sourceEventName: String
    ) {
        let token = UUID()
        pendingFallbackNotifications[conversationId] = token

        Task { [weak self] in
            try? await Task.sleep(nanoseconds: fallbackDelayNs)
            guard let self else { return }
            guard self.pendingFallbackNotifications[conversationId] == token else { return }

            self.pendingFallbackNotifications.removeValue(forKey: conversationId)
            let nowMs = Date().timeIntervalSince1970 * 1000
            self.fallbackDeliveredAtMs[conversationId] = nowMs
            self.pruneFallbackMarkers(nowMs: nowMs)

            let body: String
            if sourceEventName == "guardian.question" {
                body = "A guardian question needs your attention."
            } else {
                body = "A notification needs your attention."
            }

            self.postNotificationIntent(
                sourceEventName: sourceEventName,
                title: title,
                body: body,
                deepLinkMetadata: ["conversationId": AnyCodable(conversationId)]
            )
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
                guard !self.isBootstrapping else { return }
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
                    guard !self.isBootstrapping else { return }
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
                guard !self.isBootstrapping else { return }
                self.showMainWindow()
            }
            return
        }

        if categoryId == "NOTIFICATION_INTENT" {
            let userInfo = response.notification.request.content.userInfo
            let conversationId =
                userInfo["conversationId"] as? String ??
                userInfo["conversation_id"] as? String
            let deliveryId = userInfo["deliveryId"] as? String
            let nowMs = Int(Date().timeIntervalSince1970 * 1000)

            switch response.actionIdentifier {
            case UNNotificationDismissActionIdentifier:
                // User swiped away / dismissed the notification
                if let deliveryId {
                    await MainActor.run {
                        try? self.daemonClient.sendNotificationDeliveryInteraction(
                            deliveryId: deliveryId,
                            interactionType: "dismissed",
                            confidence: "explicit",
                            source: "macos_notification_dismiss_action",
                            occurredAt: nowMs
                        )
                    }
                }
            default:
                // Default action (clicked banner) or VIEW_NOTIFICATION_INTENT
                if let deliveryId {
                    await MainActor.run {
                        try? self.daemonClient.sendNotificationDeliveryInteraction(
                            deliveryId: deliveryId,
                            interactionType: "viewed",
                            confidence: "explicit",
                            source: "macos_notification_view_action",
                            occurredAt: nowMs
                        )
                    }
                }
                await MainActor.run {
                    guard !self.isBootstrapping else { return }
                    if let conversationId {
                        self.openConversationThread(conversationId: conversationId)
                    } else {
                        self.showMainWindow()
                    }
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
