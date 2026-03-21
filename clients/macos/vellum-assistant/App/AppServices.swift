import VellumAssistantShared

/// Single owner of app-lifetime services. Replaces scattered service properties
/// that were previously declared directly on `AppDelegate`.
@MainActor
public final class AppServices {
    public let connectionManager = GatewayConnectionManager()

    /// Backward-compat accessor — daemonClient IS connectionManager now.
    public var daemonClient: GatewayConnectionManager { connectionManager }

    public let authManager = AuthManager()
    public let ambientAgent = AmbientAgent()
    let surfaceManager = SurfaceManager()
    let secretPromptManager = SecretPromptManager()
    let zoomManager = ZoomManager()

    /// Shared settings state consumed by SettingsPanel and its tab views.
    public lazy var settingsStore: SettingsStore = SettingsStore(
        daemonClient: connectionManager,
        eventStreamClient: connectionManager.eventStreamClient
    )

    /// Reconfigure the connection for a new assistant.
    func reconfigureDaemonClient(config: DaemonConfig) {
        let conversationKey: String?
        if case .http(_, _, let key) = config.transport { conversationKey = key } else { conversationKey = nil }
        connectionManager.reconfigure(
            instanceDir: config.instanceDir,
            conversationKey: conversationKey
        )
    }
}
