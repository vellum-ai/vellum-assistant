import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ReturningUserRouter")

/// The post-auth routing decision for a returning user.
public enum RoutingDecision: Sendable, Equatable {
    case autoConnect
    case showHostingPicker
}

/// A snapshot of the assistants visible to the app at a single point in time.
///
/// `platformWasConsulted` distinguishes "platform returned nothing"
/// (authoritative) from "platform fetch failed or was skipped" (lockfile-only).
public struct AssistantLandscape: Sendable {
    public let lockfileAssistants: [LockfileAssistant]
    public let platformAssistants: [PlatformAssistant]
    public let platformWasConsulted: Bool

    public init(
        lockfileAssistants: [LockfileAssistant],
        platformAssistants: [PlatformAssistant],
        platformWasConsulted: Bool
    ) {
        self.lockfileAssistants = lockfileAssistants
        self.platformAssistants = platformAssistants
        self.platformWasConsulted = platformWasConsulted
    }

    public var currentEnvironmentLockfileAssistants: [LockfileAssistant] {
        lockfileAssistants.filter(\.isCurrentEnvironment)
    }

    public var currentEnvironmentLocalLockfileAssistants: [LockfileAssistant] {
        lockfileAssistants.filter { $0.isCurrentEnvironment && !$0.isManaged }
    }

    /// Deduplicated count of connectable assistants. When the platform was
    /// consulted it is authoritative for managed entries, so only local
    /// lockfile entries are added to its count.
    public var totalCount: Int {
        if platformWasConsulted {
            return platformAssistants.count + currentEnvironmentLocalLockfileAssistants.count
        }
        return currentEnvironmentLockfileAssistants.count
    }
}

/// Centralizes the post-auth routing decision. `decideFast()` is the
/// synchronous lockfile-only happy path; `route()` fetches the full
/// landscape when the fast path is inconclusive.
@MainActor
public final class ReturningUserRouter {
    private let lockfileProvider: () -> [LockfileAssistant]
    private let organizationIdProvider: () -> String?
    private let authServiceProvider: () -> ManagedAssistantBootstrapAuthServicing?
    private let platformTimeout: Duration

    public init(
        lockfileProvider: @escaping () -> [LockfileAssistant] = { LockfileAssistant.loadAll() },
        organizationIdProvider: @escaping () -> String? = {
            UserDefaults.standard.string(forKey: "connectedOrganizationId")
        },
        authServiceProvider: @escaping () -> ManagedAssistantBootstrapAuthServicing? = {
            AuthService.shared
        },
        platformTimeout: Duration = .seconds(5)
    ) {
        self.lockfileProvider = lockfileProvider
        self.organizationIdProvider = organizationIdProvider
        self.authServiceProvider = authServiceProvider
        self.platformTimeout = platformTimeout
    }

    /// Fast path: the lockfile alone can answer only for non-managed
    /// assistants. Managed entries can be revoked or deleted on the
    /// platform, so they must be validated via the async `route()` path
    /// before we auto-connect.
    public func decideFast() -> RoutingDecision? {
        let hasLocalCurrentEnv = lockfileProvider().contains { $0.isCurrentEnvironment && !$0.isManaged }
        return hasLocalCurrentEnv ? .autoConnect : nil
    }

    public func decide(for landscape: AssistantLandscape) -> RoutingDecision {
        let count = landscape.totalCount
        log.info("decide: \(count) connectable assistant(s) visible")
        return count == 0 ? .showHostingPicker : .autoConnect
    }

    public func fetchLandscape() async -> AssistantLandscape {
        let lockfile = lockfileProvider()
        let (platform, consulted) = await fetchPlatformAssistants()
        return AssistantLandscape(
            lockfileAssistants: lockfile,
            platformAssistants: platform,
            platformWasConsulted: consulted
        )
    }

    public func route() async -> RoutingDecision {
        decide(for: await fetchLandscape())
    }

    /// Fetches the platform list with a bounded wait. Uses unstructured
    /// tasks (rather than `withTaskGroup`) because a task group blocks its
    /// `body` until every child task has finished, which would extend the
    /// wait past `platformTimeout` if the network call does not cooperate
    /// with cancellation. `URLSession` does, but keeping the upper bound
    /// independent of the fetch's cancellation behaviour is safer.
    private func fetchPlatformAssistants() async -> ([PlatformAssistant], Bool) {
        guard let orgId = organizationIdProvider(), !orgId.isEmpty else {
            return ([], false)
        }
        guard let auth = authServiceProvider() else {
            return ([], false)
        }
        let timeout = platformTimeout
        let fetchTask = Task { @MainActor () -> ([PlatformAssistant], Bool) in
            do {
                let list = try await auth.listAssistants(organizationId: orgId)
                return (list, true)
            } catch is CancellationError {
                return ([], false)
            } catch {
                log.warning("platform fetch failed: \(String(describing: error), privacy: .public)")
                return ([], false)
            }
        }
        let timeoutTask = Task { [fetchTask] in
            try? await Task.sleep(for: timeout)
            if !Task.isCancelled {
                log.warning("platform fetch timed out after \(timeout, privacy: .public)")
                fetchTask.cancel()
            }
        }
        defer { timeoutTask.cancel() }
        return await fetchTask.value
    }
}
