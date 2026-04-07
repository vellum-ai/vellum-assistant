import Foundation

/// A client that manages the lifecycle of a local assistant instance.
///
/// Adopt this protocol to add a new backend (e.g. Apple Containers) without
/// changing the startup logic in `AppDelegate`. The app reads
/// `LockfileAssistant.isAppleContainer` and dispatches to the appropriate client.
@MainActor
protocol AssistantManagementClient: AnyObject {
    /// Hatch (start or re-start) the local assistant.
    ///
    /// - Parameters:
    ///   - name: The assistant ID to hatch. Pass `nil` to let the client
    ///     choose the name (e.g. first-launch scenario).
    ///   - restart: When `true`, stop any running instance before starting.
    ///   - configValues: Key-value pairs forwarded as `--config k=v` flags.
    func hatch(name: String?, restart: Bool, configValues: [String: String]) async throws
}
