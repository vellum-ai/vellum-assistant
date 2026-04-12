import Foundation

/// A client that manages the lifecycle of a local assistant instance.
///
/// Adopt this protocol to add a new backend (e.g. Apple Containers) without
/// changing the startup logic in `AppDelegate`. The app reads
/// `LockfileAssistant.isAppleContainer` and dispatches to the appropriate client.
@MainActor
protocol AssistantManagementClient: AnyObject {
    /// Hatch (start) a local assistant from scratch.
    ///
    /// - Parameters:
    ///   - name: The assistant ID to hatch. Pass `nil` to let the client
    ///     choose the name (e.g. first-launch scenario).
    ///   - configValues: Key-value pairs forwarded as `--config k=v` flags.
    func hatch(name: String?, configValues: [String: String]) async throws

    /// Retire (stop and clean up) a running assistant.
    ///
    /// Implementations should stop the runtime, remove instance data, and
    /// clean up the lockfile entry.
    ///
    /// - Parameter name: The assistant ID to retire.
    func retire(name: String) async throws
}
