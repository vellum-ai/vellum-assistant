#if canImport(UIKit)
import UIKit

/// Handles iOS scene lifecycle events, reconnecting the daemon client
/// whenever the app returns to the foreground from a backgrounded state.
///
/// The initial connection attempt on launch is handled by ContentView
/// (which shows a "Connecting..." screen). SceneDelegate only handles
/// subsequent background→foreground reconnections.
class SceneDelegate: NSObject, UIWindowSceneDelegate {
    private var hasLaunched = false

    func sceneWillEnterForeground(_ scene: UIScene) {
        // ContentView owns the initial connection attempt so it can
        // show a connecting screen instead of flashing disconnected tabs.
        guard hasLaunched else {
            hasLaunched = true
            return
        }
        guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
        let provider = appDelegate.clientProvider
        guard !provider.client.isConnected else { return }
        // @MainActor ensures isConnected assignment runs on the main actor,
        // which is required for @Published properties on @MainActor types.
        // The Combine bridge in ClientProvider auto-syncs isConnected from
        // GatewayConnectionManager, so no manual state management is needed here.
        Task { @MainActor in
            try? await provider.client.connect()
        }
    }
}
#endif
