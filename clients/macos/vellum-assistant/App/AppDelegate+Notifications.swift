import AppKit
import UserNotifications
import CoreText
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AppDelegate+Notifications")
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
            options: []
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
            voiceResponseCategory,
            notificationIntentCategory,
        ])
    }

    /// Handles notification permission when a notification conversation arrives while
    /// the app is active. This provides user-visible context for the OS prompt
    /// and gives an immediate recovery path when the app is already denied.
    func maybePromptNotificationAuthorizationForConversationCreated() {
        Task { @MainActor in
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                return
            case .notDetermined:
                guard !hasRequestedNotificationAuthorizationFromConversationSignal else { return }
                hasRequestedNotificationAuthorizationFromConversationSignal = true
                log.info("Requesting notification authorization from notification_conversation_created signal")
                requestNotificationAuthorization(trigger: "notification_conversation_created", showDeniedToast: true)
            case .denied:
                showNotificationPermissionSettingsToastIfNeeded()
            @unknown default:
                return
            }
        }
    }

    private func requestNotificationAuthorization(trigger: String, showDeniedToast: Bool) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
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
            message: "Notifications are off for Vellum. Turn them on in System Settings to receive banners and dock badges.",
            style: .warning,
            primaryAction: VToastAction(label: "Open Settings") { [weak self] in
                self?.openNotificationSettings()
            }
        )
    }

    private func openNotificationSettings() {
        if !PermissionManager.openNotificationSettings() {
            log.warning("Failed to open macOS Notification settings URL")
        }
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

    private nonisolated func messageId(from userInfo: [AnyHashable: Any]) -> String? {
        if let direct = userInfo["messageId"] as? String {
            return direct
        }
        if let snake = userInfo["message_id"] as? String {
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
        content.attachAppIcon()

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

            // Play the custom notification sound only after confirming authorization.
            // The system sound (`UNNotificationSound.default`) plays when the banner appears,
            // while this custom sound provides the configurable audio feedback from SoundManager.
            // Both are kept so users get the system banner sound even if custom sounds are disabled.
            SoundManager.shared.play(.notification)

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
        Task {
            await NotificationClient().sendIntentResult(
                deliveryId: deliveryId,
                success: success,
                errorMessage: errorMessage,
                errorCode: errorCode
            )
        }
    }

    func deliverNotificationIntent(_ msg: NotificationIntentMessage) {
        // Guardian scoping: skip notifications targeted at a different guardian.
        // When the local principal is nil (not yet bootstrapped), pass through all
        // notifications so urgent prompts aren't silently missed during startup.
        if let target = msg.targetGuardianPrincipalId {
            let localId = ActorTokenManager.getGuardianPrincipalId()
            if let localId, localId != target {
                log.info("Skipping notification_intent for guardian \(target) — local guardian is \(localId)")
                // Ack so the delivery audit trail stays consistent
                if let deliveryId = msg.deliveryId {
                    sendNotificationIntentResult(deliveryId: deliveryId, success: true, errorMessage: nil, errorCode: nil)
                }
                return
            }
        }

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

        // When a notification intent targets a conversation the client already knows
        // about (reuse case), mark it as unseen and trigger a history catch-up so the
        // new message appears in the chat view. New conversations are handled by
        // notification_conversation_created instead.
        if let conversationId = conversationId(from: msg.deepLinkMetadata) {
            mainWindow?.conversationManager.handleNotificationIntentForExistingConversation(
                daemonConversationId: conversationId
            )
        }

        postNotificationIntent(
            sourceEventName: msg.sourceEventName,
            title: msg.title,
            body: msg.body,
            deepLinkMetadata: msg.deepLinkMetadata,
            deliveryId: msg.deliveryId
        )
    }

    /// Schedules a fallback local notification for any notification_conversation_created
    /// event. If the corresponding notification_intent event arrives within the
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

    /// Send a `conversation_seen_signal` message to the daemon.
    func sendConversationSeenSignal(
        conversationId: String,
        signalType: String,
        source: String,
        evidenceText: String? = nil
    ) {
        let signal = ConversationSeenSignal(
            conversationId: conversationId,
            sourceChannel: "vellum",
            signalType: signalType,
            confidence: "explicit",
            source: source,
            evidenceText: evidenceText
        )
        Task {
            let success = await conversationListClient.sendConversationSeen(signal)
            if !success {
                log.warning("Failed to send conversation_seen_signal for \(conversationId)")
            }
        }
    }

    nonisolated static func registerBundledFonts() {
        let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AppDelegate+Notifications")
        for name in ["DMMono-Regular", "DMMono-Medium", "DMSans-Regular", "DMSans-Medium", "DMSans-SemiBold", "InstrumentSerif-Regular"] {
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
            let conversationId = response.notification.request.content.userInfo["conversationId"] as? String
            await MainActor.run {
                guard !self.isBootstrapping else { return }
                if let conversationId, !conversationId.isEmpty {
                    self.openConversation(conversationId: conversationId)
                } else {
                    self.showMainWindow()
                }
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
            default:
                // User clicked the notification banner — bring app forward to the
                // confirmation's conversation and let the inline bubble handle it.
                // Do NOT auto-deny.
                await MainActor.run {
                    guard !self.isBootstrapping else { return }
                    let conversationId = response.notification.request.content.userInfo["conversationId"] as? String
                    if let conversationId {
                        self.openConversation(conversationId: conversationId)
                    } else {
                        self.showMainWindow()
                    }
                }
                await MainActor.run {
                    self.toolConfirmationNotificationService.handleInlineResponse(requestId: requestId)
                }
                // Remove the delivered notification since the user is now in the app
                UNUserNotificationCenter.current().removeDeliveredNotifications(
                    withIdentifiers: [response.notification.request.identifier]
                )
                return
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
            let conversationId =
                response.notification.request.content.userInfo["conversationId"] as? String ??
                response.notification.request.content.userInfo["conversation_id"] as? String
            let messageId = self.messageId(from: response.notification.request.content.userInfo)
            await MainActor.run {
                guard !self.isBootstrapping else { return }
                if let conversationId {
                    self.openConversation(conversationId: conversationId, anchorMessageId: messageId)
                    self.sendConversationSeenSignal(
                        conversationId: conversationId,
                        signalType: "macos_notification_view",
                        source: "notification-action",
                        evidenceText: "User clicked View on notification"
                    )
                    // Clear local unseen state so sidebar dot disappears immediately
                    if let conversationIdx = self.mainWindow?.conversationManager.conversations.firstIndex(where: { $0.conversationId == conversationId }) {
                        self.mainWindow?.conversationManager.conversations[conversationIdx].hasUnseenLatestAssistantMessage = false
                    }
                } else {
                    self.showMainWindow()
                }
            }
            return
        }

    }
}
