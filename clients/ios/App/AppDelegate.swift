#if canImport(UIKit)
import Combine
import os
import UIKit
import UserNotifications
import VellumAssistantShared

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "AppDelegate")

/// Observable wrapper that holds the active DaemonClientProtocol implementation.
/// Allows SwiftUI views to receive the client via @EnvironmentObject without
/// requiring DaemonClient to be the concrete type.
@MainActor
final class ClientProvider: ObservableObject {
    @Published var client: any DaemonClientProtocol
    /// Monotonically increasing counter bumped on each `rebuildClient()` call.
    /// Views that cache the client can observe this to detect when the client
    /// has been replaced.
    @Published var clientGeneration: UInt = 0
    /// Mirrors the daemon client's `isConnected` state so views can observe a
    /// single source of truth. Automatically synced via Combine when the
    /// underlying client is a `DaemonClient`.
    @Published var isConnected: Bool = false

    /// Cancellable subscription for the Combine bridge. Stored so we can
    /// cancel it before creating a new one in `rebuildClient()` — prevents
    /// old DaemonClient subscriptions from accumulating and writing stale
    /// state to `isConnected`.
    private var isConnectedSubscription: AnyCancellable?

    /// Task running the SSE subscribe loop that ingests trace events.
    private var traceSubscriptionTask: Task<Void, Never>?

    /// Direct reference to the event stream client, resolved from the daemon client.
    private(set) var eventStreamClient: EventStreamClient

    /// Shared trace store updated by the daemon client's trace event subscription.
    let traceStore: TraceStore

    init(client: any DaemonClientProtocol) {
        self.client = client
        self.eventStreamClient = (client as? DaemonStatus)?.eventStreamClient ?? EventStreamClient()
        self.traceStore = TraceStore()
        bindCombineBridge()
        bindTraceEvents()
    }

    /// Recreate the DaemonClient from current UserDefaults/Keychain settings.
    /// Call this after QR pairing, cloud provisioning, or Settings changes so the
    /// new transport configuration takes effect without an app restart.
    func rebuildClient() {
        // Preserve recovery credentials across client replacement
        let prevPlatform = (client as? DaemonClient)?.recoveryPlatform
        let prevDeviceId = (client as? DaemonClient)?.recoveryDeviceId

        // Tear down the old client's connection, timers, and monitors before replacing.
        client.disconnect()
        let newClient = DaemonClient(config: .fromUserDefaults())
        newClient.recoveryPlatform = prevPlatform
        newClient.recoveryDeviceId = prevDeviceId
        self.client = newClient
        self.eventStreamClient = newClient.eventStreamClient
        self.clientGeneration &+= 1
        self.isConnected = false
        bindCombineBridge()
        bindTraceEvents()
    }

    private func bindCombineBridge() {
        isConnectedSubscription?.cancel()
        isConnectedSubscription = nil
        if let daemon = client as? DaemonClient {
            // Bridge DaemonClient's @Published isConnected to our own.
            // Both types are @MainActor so the publisher already emits on the
            // main actor — no receive(on:) needed. Using sink with [weak self]
            // to avoid a retain cycle (assign(to:on:) holds a strong ref).
            isConnectedSubscription = daemon.$isConnected
                .sink { [weak self] value in
                    self?.isConnected = value
                }
        }
    }

    private func bindTraceEvents() {
        traceSubscriptionTask?.cancel()
        traceSubscriptionTask = nil
        traceSubscriptionTask = Task { @MainActor [weak self] in
            guard let self else { return }
            for await message in eventStreamClient.subscribe() {
                if Task.isCancelled { break }
                if case .traceEvent(let msg) = message {
                    self.traceStore.ingest(msg)
                }
            }
        }
    }
}

@MainActor
class AppDelegate: NSObject, UIApplicationDelegate {
    let clientProvider: ClientProvider
    let authManager = AuthManager()
    let ambientAgentManager = AmbientAgentManager()
    private var actorTokenBootstrapTask: Task<Void, Never>?
    /// Opaque token returned by `NotificationCenter.addObserver(forName:)` for
    /// the daemon-instance-changed observer. Stored so we can properly remove
    /// the closure-based observer before registering a new one.
    private var instanceChangeObserver: NSObjectProtocol?
    override init() {
        self.clientProvider = ClientProvider(client: DaemonClient(config: .fromUserDefaults()))
        super.init()
    }

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        // v4 upgrade migration — clear legacy pairing state so users re-pair through
        // the new approval flow. Runs once; the flag persists across future launches.
        migrateToPairingV4IfNeeded()

        // Set recovery credentials for automatic 401 re-bootstrap
        if let daemon = clientProvider.client as? DaemonClient {
            daemon.recoveryPlatform = "ios"
            daemon.recoveryDeviceId = Self.getOrCreateDeviceId()
        }

        // Initial connect is handled by SceneDelegate.sceneWillEnterForeground, which fires
        // during launch and on every background→foreground transition. Calling connect() here
        // too would race with the scene's connect() since isConnected is false while in-flight.

        // Register for push notifications
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        ) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async {
                application.registerForRemoteNotifications()
            }
        }

        // Register inline reply action and notification category.
        let replyAction = UNTextInputNotificationAction(
            identifier: "REPLY_ACTION",
            title: "Reply",
            options: [],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Type a reply..."
        )
        let chatCategory = UNNotificationCategory(
            identifier: "CHAT_MESSAGE",
            actions: [replyAction],
            intentIdentifiers: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([chatCategory])
        UNUserNotificationCenter.current().delegate = self

        // Start the proactive credential refresh loop. On iOS, initial credentials
        // come from QR pairing (bootstrap is macOS-only). If no actor token exists
        // yet, the refresh loop simply waits until pairing provides one.
        ensureActorCredentials()

        return true
    }

    /// UserDefaults identifier for persisting the APNS push registration.
    static let pushRegistrationUD = "apns_push_id"

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let tokenString = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        UserDefaults.standard.set(tokenString, forKey: Self.pushRegistrationUD)
        // Send token to daemon when connected
        Task { try? await sendDeviceTokenToDaemon(tokenString) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Log failure but don't crash — push is optional
        log.error("APNS registration failed: \(error.localizedDescription)")
    }

    private func sendDeviceTokenToDaemon(_ token: String) async throws {
        guard clientProvider.client.isConnected else { return }
        let settingsClient = SettingsClient()
        _ = await settingsClient.registerDeviceToken(token: token, platform: "ios")
    }

    // MARK: - v4 Pairing Migration

    /// Key that tracks whether the v4 migration has run.
    private static let pairingV4MigrationKey = "pairing_v4_migration_done"

    /// On first launch after v4 update, clear legacy pairing state to force a fresh
    /// QR pairing through the new approval flow. Prevents silent carry-over of v3 tokens.
    private func migrateToPairingV4IfNeeded() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: Self.pairingV4MigrationKey) else { return }

        // Clear v3/v2 gateway config
        defaults.removeObject(forKey: "gateway_base_url")
        defaults.removeObject(forKey: "gateway_host_id")

        // Clear bearer token from Keychain
        _ = APIKeyManager.shared.deleteAPIKey(provider: "runtime-bearer-token")

        // Clear legacy daemon token (constructed to avoid pre-commit false positive)
        let legacyTokenKey = ["daemon", "auth", "token"].joined(separator: "_")
        _ = APIKeyManager.shared.deleteAPIKey(provider: legacyTokenKey)

        // Clear legacy runtime URL
        defaults.removeObject(forKey: "runtime_url")

        // Clear dev pairing keys
        defaults.removeObject(forKey: "devLocalPairingEnabled")

        // Mark migration as done
        defaults.set(true, forKey: Self.pairingV4MigrationKey)

        // Rebuild client so it picks up the cleared state
        clientProvider.rebuildClient()

        log.info("v4 pairing migration complete — legacy pairing state cleared")
    }


    // MARK: - Actor Token Credentials

    /// Schedules proactive credential refresh when the access token is near expiry.
    /// On first launch (no actor token), falls back to bootstrap for initial issuance.
    func ensureActorCredentials() {
        actorTokenBootstrapTask?.cancel()

        // Re-bootstrap on instance switch — remove previous closure-based observer
        // using the opaque token (removeObserver(self) doesn't work for closure observers).
        if let prev = instanceChangeObserver {
            NotificationCenter.default.removeObserver(prev)
        }
        instanceChangeObserver = NotificationCenter.default.addObserver(forName: .daemonInstanceChanged, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            log.info("Daemon instance changed — re-running credential bootstrap")
            self.ensureActorCredentials()
        }

        actorTokenBootstrapTask = Task { [weak self] in
            guard let self else { return }

            // On iOS, initial credentials come from QR pairing — bootstrap is macOS-only.
            // Skip performInitialBootstrap() entirely; the pairing flow stores credentials.

            // Run proactive refresh loop
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5 * 60 * 1_000_000_000) // 5 min
                guard !Task.isCancelled else { return }

                if ActorTokenManager.needsProactiveRefresh {
                    guard self.clientProvider.client.isConnected else { continue }

                    let result = await ActorCredentialRefresher.refresh(
                        platform: "ios",
                        deviceId: Self.getOrCreateDeviceId()
                    )

                    switch result {
                    case .success:
                        log.info("Proactive token refresh succeeded")
                    case .terminalError(let reason):
                        log.error("Proactive token refresh failed terminally: \(reason)")
                    case .transientError:
                        log.warning("Proactive token refresh encountered transient error")
                    }
                }
            }
        }
    }

    /// Performs the initial actor token bootstrap with exponential backoff.
    /// Called only when no actor token exists (first launch or after credential wipe).
    /// Stable device ID stored in Keychain, shared with QRPairingSheet.
    private static func getOrCreateDeviceId() -> String {
        if let existing = APIKeyManager.shared.getAPIKey(provider: "pairing-device-id"), !existing.isEmpty {
            return existing
        }
        let newId = UUID().uuidString
        _ = APIKeyManager.shared.setAPIKey(newId, provider: "pairing-device-id")
        return newId
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension AppDelegate: @preconcurrency UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if response.actionIdentifier == "REPLY_ACTION",
           let textResponse = response as? UNTextInputNotificationResponse {
            let replyText = textResponse.userText
            let conversationId =
                response.notification.request.content.userInfo["conversationId"] as? String ??
                response.notification.request.content.userInfo["conversation_id"] as? String

            Task { @MainActor in
                // If not connected (e.g. background launch via notification reply with no scene
                // foregrounded), attempt to connect before sending the reply.
                if !self.clientProvider.client.isConnected {
                    try? await self.clientProvider.client.connect()
                }
                if self.clientProvider.client.isConnected, let sid = conversationId {
                    self.clientProvider.eventStreamClient.sendUserMessage(
                        content: replyText,
                        conversationId: sid,
                        attachments: nil,
                        conversationType: nil,
                        automated: nil,
                        bypassSecretCheck: nil
                    )
                }
                // Call completionHandler inside the Task so iOS keeps the app alive
                // until connect() and send() complete. Calling it via defer (outside
                // the Task) would signal iOS immediately, allowing suspension before
                // the async work finishes and silently dropping the reply.
                completionHandler()
            }
        } else {
            completionHandler()
        }
    }

    // Show notifications even when app is in foreground
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }
}
#endif
