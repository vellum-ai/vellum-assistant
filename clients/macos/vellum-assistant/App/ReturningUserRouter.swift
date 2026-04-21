import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ReturningUserRouter")

/// Post-authentication routing for returning users.
///
/// Centralizes the "what should happen after auth" decision so
/// `AppDelegate+AuthLifecycle` and `ReauthView` share one source of truth
/// instead of each re-deriving the answer from the lockfile alone.
///
/// Two data sources are consulted in parallel:
/// - **Lockfile** (local, synchronous) — always available.
/// - **Platform assistant list** (network, async) — authoritative for managed
///   assistants but may be unavailable; the router degrades gracefully.
@MainActor
final class ReturningUserRouter {

    // MARK: - Types

    enum RoutingDecision: Equatable, CustomStringConvertible {
        /// Proceed directly to the app with the current (or latest) assistant.
        case autoConnect
        /// No assistants found — show the hosting-option picker so the user
        /// can hatch or set one up.
        case showHostingPicker
        /// Multiple assistants (or one with multi-assistant flag) — show the
        /// assistant picker so the user explicitly chooses which to connect.
        case showAssistantPicker

        var description: String {
            switch self {
            case .autoConnect: "autoConnect"
            case .showHostingPicker: "showHostingPicker"
            case .showAssistantPicker: "showAssistantPicker"
            }
        }
    }

    /// Read-only snapshot of what the router discovered about the user's
    /// assistant landscape from both local and remote sources.
    struct AssistantLandscape {
        let lockfileAssistants: [LockfileAssistant]
        let platformAssistants: [PlatformAssistant]
        let platformWasConsulted: Bool

        var currentEnvironmentLockfileAssistants: [LockfileAssistant] {
            lockfileAssistants.filter(\.isCurrentEnvironment)
        }

        var currentEnvironmentLocalLockfileAssistants: [LockfileAssistant] {
            lockfileAssistants.filter { $0.isCurrentEnvironment && !$0.isManaged }
        }

        /// Deduplicated count. When the platform was consulted, managed
        /// lockfile entries are excluded (the platform list is authoritative
        /// for those) to avoid double-counting.
        var totalCount: Int {
            if platformWasConsulted {
                return currentEnvironmentLocalLockfileAssistants.count + platformAssistants.count
            }
            return currentEnvironmentLockfileAssistants.count
        }
    }

    // MARK: - Dependencies

    private let organizationIdProvider: () -> String?
    private let authServiceProvider: () -> ManagedAssistantBootstrapAuthServicing?
    private let lockfileLoader: () -> [LockfileAssistant]
    private let multiAssistantFlagProvider: () -> Bool

    private static let platformTimeoutSeconds: UInt64 = 5

    init(
        organizationIdProvider: @escaping () -> String? = {
            UserDefaults.standard.string(forKey: "connectedOrganizationId")
        },
        authServiceProvider: @escaping () -> ManagedAssistantBootstrapAuthServicing? = {
            AuthService.shared
        },
        lockfileLoader: @escaping () -> [LockfileAssistant] = {
            LockfileAssistant.loadAll()
        },
        multiAssistantFlagProvider: @escaping () -> Bool = {
            MacOSClientFeatureFlagManager.shared.isEnabled("multi-platform-assistant")
        }
    ) {
        self.organizationIdProvider = organizationIdProvider
        self.authServiceProvider = authServiceProvider
        self.lockfileLoader = lockfileLoader
        self.multiAssistantFlagProvider = multiAssistantFlagProvider
    }

    // MARK: - Routing

    /// Synchronous fast path — lockfile only, no network.
    ///
    /// Returns `.autoConnect` when any current-environment entry exists,
    /// `nil` when there are none (caller should fall through to the auth
    /// window or the async ``route()`` path).
    func decideFast() -> RoutingDecision? {
        let all = lockfileLoader()
        let current = all.filter(\.isCurrentEnvironment)
        guard !current.isEmpty else { return nil }
        if current.count > 1 || (current.count == 1 && multiAssistantFlagProvider()) {
            log.info("decideFast: \(current.count) current-env entries + multiFlag — showAssistantPicker")
            return .showAssistantPicker
        }
        log.info("decideFast: \(current.count) current-env lockfile entries — autoConnect")
        return .autoConnect
    }

    /// Fetch the assistant landscape from both sources.
    func fetchLandscape() async throws -> AssistantLandscape {
        let lockfile = lockfileLoader()

        guard let orgId = organizationIdProvider(),
              let authService = authServiceProvider() else {
            log.info("fetchLandscape: no org ID or auth service — skipping platform fetch")
            return AssistantLandscape(
                lockfileAssistants: lockfile,
                platformAssistants: [],
                platformWasConsulted: false
            )
        }

        do {
            let platform = try await withTimeout(seconds: Self.platformTimeoutSeconds) {
                try await authService.listAssistants(organizationId: orgId)
            }
            log.info("fetchLandscape: \(lockfile.count) lockfile, \(platform.count) platform")
            return AssistantLandscape(
                lockfileAssistants: lockfile,
                platformAssistants: platform,
                platformWasConsulted: true
            )
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            log.warning("fetchLandscape: platform fetch failed — \(error.localizedDescription, privacy: .public)")
            return AssistantLandscape(
                lockfileAssistants: lockfile,
                platformAssistants: [],
                platformWasConsulted: false
            )
        }
    }

    /// Pure routing decision from a pre-fetched landscape.
    func decide(for landscape: AssistantLandscape) -> RoutingDecision {
        let total = landscape.totalCount
        let hasMultiFlag = multiAssistantFlagProvider()
        log.info("decide: totalCount=\(total) multiFlag=\(hasMultiFlag) platformConsulted=\(landscape.platformWasConsulted)")
        if total == 0 {
            return .showHostingPicker
        }
        if total > 1 || (total == 1 && hasMultiFlag) {
            return .showAssistantPicker
        }
        return .autoConnect
    }

    /// Convenience: fetch the landscape and return the decision.
    func route() async throws -> RoutingDecision {
        decide(for: try await fetchLandscape())
    }

    // MARK: - Helpers

    /// Thrown when the platform fetch exceeds the timeout. Distinct from
    /// `CancellationError` so callers can tell a timeout apart from a
    /// parent-task cancellation.
    private struct PlatformTimeoutError: Error {}

    /// Run an async closure with a timeout.
    private func withTimeout<T: Sendable>(
        seconds: UInt64,
        operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(nanoseconds: seconds * 1_000_000_000)
                throw PlatformTimeoutError()
            }
            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }
}
