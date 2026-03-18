import VellumAssistantShared

/// Single owner of app-lifetime services. Replaces scattered service properties
/// that were previously declared directly on `AppDelegate`.
@MainActor
public final class AppServices {
    public private(set) var daemonClient: DaemonClient
    public let authManager = AuthManager()
    public let ambientAgent = AmbientAgent()
    let surfaceManager = SurfaceManager()
    let secretPromptManager = SecretPromptManager()
    let zoomManager = ZoomManager()
    let conversationZoomManager = ConversationZoomManager()

    /// Shared settings state consumed by SettingsPanel and its tab views.
    /// Lazy because it needs `ambientAgent` and `daemonClient` which are set above.
    public lazy var settingsStore: SettingsStore = SettingsStore(
        daemonClient: daemonClient
    )

    init() {
        self.daemonClient = DaemonClient()
    }

    /// Reconfigure the daemon client's transport in place (e.g., for HTTP transport).
    /// This preserves the DaemonClient object identity so long-lived holders
    /// (ConversationManager, ChatViewModel, RecordingManager, SettingsStore) continue
    /// to reference the same instance after an assistant switch.
    func reconfigureDaemonClient(config: DaemonConfig) {
        daemonClient.reconfigure(config: config)
    }
}
