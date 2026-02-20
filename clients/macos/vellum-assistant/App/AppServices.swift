import VellumAssistantShared

/// Single owner of app-lifetime services. Replaces scattered service properties
/// that were previously declared directly on `AppDelegate`.
@MainActor
public final class AppServices {
    public private(set) var daemonClient: DaemonClient
    public let ambientAgent = AmbientAgent()
    let surfaceManager = SurfaceManager()
    let browserPiPManager = BrowserPiPManager()
    let secretPromptManager = SecretPromptManager()
    let zoomManager = ZoomManager()

    /// Shared settings state consumed by both SettingsView and SettingsPanel.
    /// Lazy because it needs `ambientAgent` and `daemonClient` which are set above.
    public lazy var settingsStore: SettingsStore = SettingsStore(
        daemonClient: daemonClient
    )

    /// Activity notification service for sending push notifications on task completion.
    /// Lazy because it needs `settingsStore` which is set above.
    public lazy var activityNotificationService: ActivityNotificationService = ActivityNotificationService(
        settingsStore: settingsStore
    )

    init() {
        self.daemonClient = DaemonClient()
    }

    /// Reconfigure the daemon client with a new config (e.g., for HTTP transport).
    /// This replaces the daemon client instance. Must be called before any callbacks
    /// are wired or connections are established.
    func reconfigureDaemonClient(config: DaemonConfig) {
        daemonClient = DaemonClient(config: config)
    }
}
