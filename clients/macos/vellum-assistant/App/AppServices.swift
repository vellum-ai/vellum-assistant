import VellumAssistantShared

/// Single owner of app-lifetime services. Replaces scattered service properties
/// that were previously declared directly on `AppDelegate`.
@MainActor
public final class AppServices {
    public let connectionManager = GatewayConnectionManager()

    public let authManager = AuthManager()
    public let ambientAgent = AmbientAgent()
    let surfaceManager = SurfaceManager()
    let secretPromptManager = SecretPromptManager()
    let zoomManager = ZoomManager()

    /// Shared feature flag store — caches resolved flags in memory so that
    /// hot paths (e.g. `SoundManager.play()`) avoid synchronous file I/O on
    /// the main thread.
    let featureFlagStore = AssistantFeatureFlagStore()

    /// Shared settings state consumed by SettingsPanel and its tab views.
    public lazy var settingsStore: SettingsStore = SettingsStore(
        connectionManager: connectionManager,
        eventStreamClient: connectionManager.eventStreamClient,
        featureFlagStore: featureFlagStore
    )

    /// Reconfigure the connection for a new assistant.
    func reconfigureConnection(conversationKey: String? = nil) {
        connectionManager.reconfigure(conversationKey: conversationKey)
    }
}
