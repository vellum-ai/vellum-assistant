#if canImport(UIKit)
import UIKit

/// Handles iOS scene lifecycle events, reconnecting the daemon client
/// whenever the app returns to the foreground from a backgrounded state.
class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func sceneWillEnterForeground(_ scene: UIScene) {
        guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
        let provider = appDelegate.clientProvider
        if provider.client.isConnected {
            provider.isConnected = true
            return
        }
        Task {
            do {
                await MainActor.run { provider.isConnected = false }
                try await provider.client.connect()
                await MainActor.run { provider.isConnected = true }
            } catch {
                // Connection failed — will retry on next foreground transition
            }
        }
    }
}
#endif
