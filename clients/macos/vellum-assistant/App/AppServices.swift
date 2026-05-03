import VellumAssistantShared

/// Single owner of app-lifetime services. Replaces scattered service properties
/// that were previously declared directly on `AppDelegate`.
@MainActor
public final class AppServices {
    public let connectionManager: GatewayConnectionManager
    let diskPressureMonitor: DiskPressureMonitor

    public let authManager = AuthManager()
    public let ambientAgent = AmbientAgent()
    let surfaceManager = SurfaceManager()
    let secretPromptManager = SecretPromptManager()
    let contactPromptManager = ContactPromptManager()
    let zoomManager = ZoomManager()

    /// Shared observable store for ACP (Agent Client Protocol) sessions.
    /// `ConversationManager`'s SSE subscriber forwards every `acpSession*`
    /// event to `handle(_:)`; list/detail panels and the inline ACP tool
    /// block all read from this single instance.
    public let acpSessionStore = ACPSessionStore()

    /// Shared settings state consumed by SettingsPanel and its tab views.
    public lazy var settingsStore: SettingsStore = SettingsStore(
        connectionManager: connectionManager,
        eventStreamClient: connectionManager.eventStreamClient
    )

    public init() {
        let connectionManager = GatewayConnectionManager()
        self.connectionManager = connectionManager
        diskPressureMonitor = DiskPressureMonitor()
    }

    /// Reconfigure the connection for a new assistant.
    func reconfigureConnection(conversationKey: String? = nil) {
        connectionManager.reconfigure(conversationKey: conversationKey)
    }
}
