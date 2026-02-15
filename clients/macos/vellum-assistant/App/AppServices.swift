import VellumAssistantShared

/// Single owner of app-lifetime services. Replaces scattered service properties
/// that were previously declared directly on `AppDelegate`.
@MainActor
public final class AppServices {
    public let daemonClient = DaemonClient()
    public let ambientAgent = AmbientAgent()
    let surfaceManager = SurfaceManager()
    let toolConfirmationManager = ToolConfirmationManager()
    let secretPromptManager = SecretPromptManager()
    let zoomManager = ZoomManager()
}
