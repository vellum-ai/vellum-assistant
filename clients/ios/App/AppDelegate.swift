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
}
#endif
