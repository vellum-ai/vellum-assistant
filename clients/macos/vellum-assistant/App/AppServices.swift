import VellumAssistantShared

/// Single owner of app-lifetime services. Replaces scattered service properties
/// that were previously declared directly on `AppDelegate`.
@MainActor
public final class AppServices {
    public let daemonClient = DaemonClient()
    public let ambientAgent = AmbientAgent()
    let surfaceManager = SurfaceManager()
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
}
