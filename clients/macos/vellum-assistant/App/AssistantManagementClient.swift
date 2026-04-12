import Foundation
import VellumAssistantShared

/// Manages the lifecycle of a local assistant instance.
///
/// Subclass to add a new backend (e.g. Apple Containers) without changing
/// the startup logic in `AppDelegate`. The factory method `create()` reads
/// `LockfileAssistant.isAppleContainer` and dispatches to the appropriate
/// subclass.
@MainActor
class AssistantManagementClient {

    // MARK: - Factory

    /// Return the management client for the currently active assistant.
    static func create() -> AssistantManagementClient {
        let entry = LockfileAssistant.loadActiveAssistantId()
            .flatMap { LockfileAssistant.loadByName($0) }
        return create(for: entry)
    }

    /// Return the management client for a specific assistant entry.
    static func create(for assistant: LockfileAssistant?) -> AssistantManagementClient {
        if let assistant, assistant.isAppleContainer,
           let launcher = AppDelegate.shared?.appleContainersLauncher {
            return launcher
        }
        return AppDelegate.shared!.vellumCli
    }

    // MARK: - Lifecycle (override in subclasses)

    /// Hatch (start) a local assistant from scratch.
    ///
    /// - Parameters:
    ///   - name: The assistant ID to hatch. Pass `nil` to let the client
    ///     choose the name (e.g. first-launch scenario).
    ///   - configValues: Key-value pairs forwarded as `--config k=v` flags.
    func hatch(name: String? = nil, configValues: [String: String] = [:]) async throws {
        fatalError("Subclasses must override hatch(name:configValues:)")
    }

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
    func retire(name: String? = nil) async throws -> LockfileAssistant? {
        fatalError("Subclasses must override retire(name:)")
    }

    // MARK: - Shared helpers

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
                try await AppDelegate.shared?.vellumCli.wake(name: candidate.assistantId)
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
