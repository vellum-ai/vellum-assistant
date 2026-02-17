#if canImport(UIKit)
import UIKit
import VellumAssistantShared

@MainActor
class AppDelegate: NSObject, UIApplicationDelegate {
    let daemonClient: DaemonClient

    override init() {
        self.daemonClient = DaemonClient(config: .default)
        super.init()
    }

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        Task {
            try? await daemonClient.connect()
        }
        return true
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
#endif
