import Foundation
import VellumAssistantShared

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
    /// On success the implementation removes the lockfile entry, clears
    /// the active assistant ID, and returns the best remaining assistant
    /// to switch to (if any). On failure, the implementation throws
    /// without modifying the lockfile so the caller can show a
    /// Force Remove / Cancel dialog.
    ///
    /// - Parameter name: The assistant ID to retire. When `nil`, the client
    ///   loads the active assistant ID from the lockfile automatically.
    /// - Returns: A replacement `LockfileAssistant` to switch to, or `nil`
    ///   if no assistants remain (caller should show onboarding).
    @discardableResult
    func retire(name: String?) async throws -> LockfileAssistant?
}

extension AssistantManagementClient {
    /// Convenience: retire the active assistant (loads ID from lockfile).
    @discardableResult
    func retire() async throws -> LockfileAssistant? {
        try await retire(name: nil)
    }

    /// Shared post-retire orchestration: clears the active assistant ID
    /// (when the retired assistant *was* the active one) and returns the best
    /// remaining assistant for the current environment.
    ///
    /// Called by each backend's `retire(name:)` after backend-specific
    /// cleanup and lockfile entry removal. Tries remote assistants first,
    /// then local assistants (waking sleeping ones via the CLI).
    ///
    /// - Parameter retiredId: The assistant ID that was just retired. The
    ///   active pointer is only cleared when it matches this ID, so
    ///   fire-and-forget retires of non-active assistants (e.g. during
    ///   teleport/transfer) don't erase the newly active pointer.
    func findReplacementAfterRetire(retiredId: String) async -> LockfileAssistant? {
        // Only clear the active pointer when the retired assistant is the
        // one currently selected. Background retires (teleport, transfer)
        // switch to the new assistant first, so the active ID is already
        // pointing at the replacement and must not be erased.
        if LockfileAssistant.loadActiveAssistantId() == retiredId {
            LockfileAssistant.setActiveAssistantId(nil)
        }

        let remaining = LockfileAssistant.loadAll().filter { $0.isCurrentEnvironment }
        guard !remaining.isEmpty else { return nil }

        // Prefer remote assistants — always reachable.
        if let remote = remaining.first(where: { $0.isRemote }) {
            return remote
        }

        // Try each local candidate: check health, then attempt wake.
        for candidate in remaining {
            if await HealthCheckClient.isReachable(for: candidate) {
                return candidate
            }
            do {
                try await ManagementClient.vellumCli.wake(name: candidate.assistantId)
                return candidate
            } catch {
                continue
            }
        }

        return nil
    }

    /// Force-removes the active assistant's lockfile entry, clears the
    /// active ID, and returns the best remaining assistant to switch to.
    /// Used by the "Force Remove" UI path when `retire()` fails.
    func forceRemoveActiveAssistant() async -> LockfileAssistant? {
        guard let activeId = LockfileAssistant.loadActiveAssistantId() else {
            return nil
        }
        LockfileAssistant.removeEntry(assistantId: activeId)
        LockfileAssistant.setActiveAssistantId(nil)
        return await findReplacementAfterRetire(retiredId: activeId)
    }
}

// MARK: - Factory

/// Namespace for the management client factory. Picks the correct backend
/// (`VellumCli` or `AppleContainersLauncher`) based on lockfile state.
///
/// Call `ManagementClient.create()` for the active assistant, or
/// `ManagementClient.create(for:)` for a specific one.
@MainActor
enum ManagementClient {

    /// The CLI-based management client. Set once during app startup.
    static var vellumCli: VellumCli!

    /// The Apple Containers launcher, if available. Set once during app startup.
    static var appleContainersLauncher: (any AssistantManagementClient)?

    /// Return the management client for the currently active assistant.
    static func create() -> any AssistantManagementClient {
        let entry = LockfileAssistant.loadActiveAssistantId()
            .flatMap { LockfileAssistant.loadByName($0) }
        return create(for: entry)
    }

    /// Return the management client for a specific assistant entry.
    static func create(for assistant: LockfileAssistant?) -> any AssistantManagementClient {
        if let assistant, assistant.isAppleContainer, let launcher = appleContainersLauncher {
            return launcher
        }
        return vellumCli
    }
}

/// Errors specific to `AssistantManagementClient` convenience methods.
enum ManagementClientError: LocalizedError {
    case noActiveAssistant

    var errorDescription: String? {
        switch self {
        case .noActiveAssistant:
            return "No active assistant found in the lockfile"
        }
    }
}
