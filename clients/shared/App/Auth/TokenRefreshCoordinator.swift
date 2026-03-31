import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "TokenRefreshCoordinator")

/// Serializes and coalesces concurrent token refresh attempts.
///
/// When multiple HTTP requests receive 401 simultaneously, each calls
/// `refreshIfNeeded()`. The actor ensures only one network refresh is
/// in-flight at a time — subsequent callers await the same `Task.value`
/// rather than firing duplicate requests.
///
/// This follows Apple's WWDC21 actor-based task coalescing pattern
/// ("Protect mutable state with Swift actors").
public actor TokenRefreshCoordinator {

    public static let shared = TokenRefreshCoordinator()

    private var refreshTask: Task<ActorCredentialRefresher.RefreshResult, Never>?

    /// Performs a credential refresh, coalescing concurrent calls.
    ///
    /// The first caller creates the refresh task; all subsequent callers
    /// that arrive while the task is in-flight await the same result.
    /// Once the task completes, the stored reference is cleared so the
    /// next call starts a fresh refresh.
    ///
    /// - Parameters:
    ///   - platform: Platform identifier ("macos" or "ios").
    ///   - deviceId: Stable device identifier for device binding.
    /// - Returns: The result of the refresh attempt.
    public func refreshIfNeeded(platform: String, deviceId: String) async -> ActorCredentialRefresher.RefreshResult {
        if let existing = refreshTask {
            log.debug("Coalescing with in-flight refresh")
            return await existing.value
        }

        let task = Task<ActorCredentialRefresher.RefreshResult, Never> {
            let result = await ActorCredentialRefresher.refresh(
                platform: platform,
                deviceId: deviceId
            )

            switch result {
            case .success:
                log.info("Token refresh succeeded")
            case .terminalError(let reason):
                if ActorTokenManager.hasToken {
                    log.error("Token refresh failed terminally: \(reason, privacy: .public) — clearing credentials for re-bootstrap")
                    ActorTokenManager.deleteAllCredentials()
                    await MainActor.run {
                        NotificationCenter.default.post(name: .daemonInstanceChanged, object: nil)
                    }
                } else {
                    log.warning("Token refresh failed terminally: \(reason, privacy: .public) — no credentials to clear")
                }
            case .transientError:
                log.warning("Token refresh transient error — will retry on next 401")
            }

            return result
        }

        refreshTask = task
        let result = await task.value
        refreshTask = nil
        return result
    }
}
