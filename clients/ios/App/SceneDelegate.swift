#if canImport(UIKit)
import UIKit

/// Handles iOS scene lifecycle events, reconnecting the daemon client
/// whenever the app returns to the foreground from a backgrounded state.
class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func sceneWillEnterForeground(_ scene: UIScene) {
        guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
        let client = appDelegate.clientProvider.client
        guard !client.isConnected else { return }
        Task { try? await client.connect() }
    }
}
#endif
