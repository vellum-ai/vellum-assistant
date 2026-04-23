import Foundation

extension Notification.Name {
    /// Posted by `GatewayConnectionManager` on the main actor immediately after `isConnected` transitions to `true`.
    public static let daemonDidReconnect = Notification.Name("daemonDidReconnect")

    /// Posted by `EventStreamClient` after the SSE connection is re-established
    /// without a full gateway reconnect. Observers can use this to recover any
    /// conversation state that may have been missed during the stream gap.
    public static let eventStreamDidReconnect = Notification.Name("eventStreamDidReconnect")

    /// Posted when the daemon's signing key fingerprint changes, indicating an instance switch.
    /// Observers should trigger credential re-bootstrap.
    public static let daemonInstanceChanged = Notification.Name("daemonInstanceChanged")

    /// Posted by `GatewayConnectionManager` when the platform reports the
    /// currently connected managed assistant no longer exists (404 on the
    /// `assistants/{id}/health` endpoint). Observers should tear down local
    /// state for the missing assistant and switch to a replacement or show
    /// onboarding.
    public static let managedAssistantRetiredRemotely = Notification.Name("managedAssistantRetiredRemotely")
}
