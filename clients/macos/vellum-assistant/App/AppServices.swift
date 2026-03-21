import VellumAssistantShared

/// Single owner of app-lifetime services. Replaces scattered service properties
/// that were previously declared directly on `AppDelegate`.
@MainActor
public final class AppServices {
    public let connectionManager = GatewayConnectionManager()
    public private(set) var daemonClient: DaemonStatus
    public let authManager = AuthManager()
    public let ambientAgent = AmbientAgent()
    let surfaceManager = SurfaceManager()
    let secretPromptManager = SecretPromptManager()
    let zoomManager = ZoomManager()

    /// Shared settings state consumed by SettingsPanel and its tab views.
    /// Lazy because it needs `ambientAgent` and `daemonClient` which are set above.
    public lazy var settingsStore: SettingsStore = SettingsStore(
        daemonClient: daemonClient,
        eventStreamClient: connectionManager.eventStreamClient
    )

    init() {
        self.daemonClient = DaemonStatus(connectionManager: connectionManager)
    }

    /// Reconfigure the connection for a new assistant.
    func reconfigureDaemonClient(config: DaemonConfig) {
        daemonClient.reconfigure(config: config)
    }
}
