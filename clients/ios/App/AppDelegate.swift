#if canImport(UIKit)
import UIKit
import UserNotifications
import VellumAssistantShared

/// Observable wrapper that holds the active DaemonClientProtocol implementation.
/// Allows SwiftUI views to receive the client via @EnvironmentObject without
/// requiring DaemonClient to be the concrete type.
@MainActor
final class ClientProvider: ObservableObject {
    @Published var client: any DaemonClientProtocol

    init(client: any DaemonClientProtocol) {
        self.client = client
    }
}

@MainActor
class AppDelegate: NSObject, UIApplicationDelegate {
    let clientProvider: ClientProvider

    override init() {
        let mode = UserDefaults.standard.string(forKey: "connection_mode") ?? ConnectionMode.standalone.rawValue
        let client: any DaemonClientProtocol
        if mode == ConnectionMode.connected.rawValue {
            client = DaemonClient(config: .fromUserDefaults())
        } else {
            client = DirectClaudeClient()
        }
        self.clientProvider = ClientProvider(client: client)
        super.init()
    }

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        Task {
            try? await clientProvider.client.connect()
        }

        // Register for push notifications
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        ) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async {
                application.registerForRemoteNotifications()
            }
        }

        // Register inline reply action
        let replyAction = UNTextInputNotificationAction(
            identifier: "REPLY_ACTION",
            title: "Reply",
            options: [],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Type a reply..."
        )
        let category = UNNotificationCategory(
            identifier: "CHAT_MESSAGE",
            actions: [replyAction],
            intentIdentifiers: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([category])
        UNUserNotificationCenter.current().delegate = self

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
        print("[APNS] Failed to register: \(error.localizedDescription)")
    }

    private func sendDeviceTokenToDaemon(_ token: String) async throws {
        guard daemonClient.isConnected else { return }
        // Send a RegisterDeviceTokenMessage to the daemon so it can route notifications
        try daemonClient.send(RegisterDeviceTokenMessage(token: token, platform: "ios"))
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

extension AppDelegate: UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }

        if response.actionIdentifier == "REPLY_ACTION",
           let textResponse = response as? UNTextInputNotificationResponse {
            let replyText = textResponse.userText
            let sessionId = response.notification.request.content.userInfo["session_id"] as? String

            Task { @MainActor in
                // If daemon is connected, send the reply via IPC
                if self.daemonClient.isConnected, let sid = sessionId {
                    try? self.daemonClient.send(UserMessageMessage(
                        sessionId: sid,
                        content: replyText,
                        attachments: nil
                    ))
                }
            }
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
