#if canImport(UIKit)
import UIKit

/// Handles iOS scene lifecycle events, reconnecting the daemon client
/// whenever the app returns to the foreground from a backgrounded state.
class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func sceneWillEnterForeground(_ scene: UIScene) {
        guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
        let provider = appDelegate.clientProvider
        guard !provider.client.isConnected else { return }
        // @MainActor ensures isConnected assignment runs on the main actor,
        // which is required for @Published properties on @MainActor types.
        Task { @MainActor in
            try? await provider.client.connect()
        }
    }
}
#endif
