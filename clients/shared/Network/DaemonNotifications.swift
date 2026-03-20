import Foundation

extension Notification.Name {
    /// Posted by `DaemonClient` on the main actor immediately after `isConnected` transitions to `true`.
    public static let daemonDidReconnect = Notification.Name("daemonDidReconnect")

    /// Posted when the daemon's signing key fingerprint changes, indicating an instance switch.
    /// Observers should trigger credential re-bootstrap.
    public static let daemonInstanceChanged = Notification.Name("daemonInstanceChanged")
}
