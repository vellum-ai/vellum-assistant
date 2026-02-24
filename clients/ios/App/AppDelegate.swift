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
    /// Mirrors the daemon client's `isConnected` state so views can observe a
    /// single source of truth. Automatically synced via Combine when the
    /// underlying client is a `DaemonClient`.
    @Published var isConnected: Bool = false

    /// Cancellable subscription for the Combine bridge. Stored so we can
    /// cancel it before creating a new one in `rebuildClient()` — prevents
    /// old DaemonClient subscriptions from accumulating and writing stale
    /// state to `isConnected`.
    private var isConnectedSubscription: AnyCancellable?

    /// Shared trace store updated by the daemon client's onTraceEvent callback.
    let traceStore: TraceStore

    init(client: any DaemonClientProtocol) {
        self.client = client
        self.traceStore = TraceStore()
        bindCombineBridge()
        bindTraceEvents()
    }

    /// Recreate the DaemonClient from current UserDefaults/Keychain settings.
    /// Call this after QR pairing, cloud provisioning, or Settings changes so the
    /// new transport configuration takes effect without an app restart.
    func rebuildClient() {
        // Tear down the old client's connection, timers, and monitors before replacing.
        client.disconnect()
        self.client = DaemonClient(config: .fromUserDefaults())
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
        guard let daemon = client as? DaemonClient else { return }
        daemon.onTraceEvent = { [weak self] msg in
            Task { @MainActor [weak self] in
                self?.traceStore.ingest(msg)
            }
        }
    }
}

@MainActor
class AppDelegate: NSObject, UIApplicationDelegate {
    let clientProvider: ClientProvider
    let authManager = AuthManager()
    let ambientAgentManager = AmbientAgentManager()

    override init() {
        self.clientProvider = ClientProvider(client: DaemonClient(config: .fromUserDefaults()))
        super.init()
    }

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
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

        // Register inline reply action and Ride Shotgun notification category.
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

        // Start the ambient agent trigger so it begins timing from launch.
        ambientAgentManager.setup()

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
        // Send a RegisterDeviceTokenMessage to the daemon so it can route notifications
        try clientProvider.client.send(RegisterDeviceTokenMessage(token: token, platform: "ios"))
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
            let sessionId = response.notification.request.content.userInfo["session_id"] as? String

            Task { @MainActor in
                // If not connected (e.g. background launch via notification reply with no scene
                // foregrounded), attempt to connect before sending the reply.
                if !self.clientProvider.client.isConnected {
                    try? await self.clientProvider.client.connect()
                }
                if self.clientProvider.client.isConnected, let sid = sessionId {
                    try? self.clientProvider.client.send(UserMessageMessage(
                        sessionId: sid,
                        content: replyText,
                        attachments: nil
                    ))
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
