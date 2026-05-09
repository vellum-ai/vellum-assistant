import VellumAssistantShared

/// Single owner of app-lifetime services. Replaces scattered service properties
/// that were previously declared directly on `AppDelegate`.
@MainActor
public final class AppServices {
    public let connectionManager: GatewayConnectionManager
    let featureFlagStore: AssistantFeatureFlagStore
    let bookmarkStore: BookmarkStore
    let diskPressureStatusStore: DiskPressureStatusStore

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
        let featureFlagStore = AssistantFeatureFlagStore()
        let bookmarkStore = BookmarkStore()
        self.connectionManager = connectionManager
        self.featureFlagStore = featureFlagStore
        self.bookmarkStore = bookmarkStore
        diskPressureStatusStore = DiskPressureStatusStore(
            eventStreamClient: connectionManager.eventStreamClient,
            featureFlagEnabled: { key in
                featureFlagStore.isEnabled(key)
            }
        )
        // Hydrate bookmarks once at bootstrap so hover-time lookups via
        // ``bookmarkedMessageIds`` are warm by the time the chat surface
        // renders. Subsequent updates flow through the SSE-driven
        // ``bookmarkDidChange`` notification.
        Task { @MainActor in
            await bookmarkStore.reload()
        }
    }

    /// Reconfigure the connection for a new assistant.
    func reconfigureConnection(conversationKey: String? = nil) {
        connectionManager.reconfigure(conversationKey: conversationKey)
    }
}
