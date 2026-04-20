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

    public func decideFast() -> RoutingDecision? {
        lockfileProvider().contains(where: \.isCurrentEnvironment) ? .autoConnect : nil
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

    private func fetchPlatformAssistants() async -> ([PlatformAssistant], Bool) {
        guard let orgId = organizationIdProvider(), !orgId.isEmpty else {
            return ([], false)
        }
        guard let auth = authServiceProvider() else {
            return ([], false)
        }
        let timeout = platformTimeout
        return await withTaskGroup(of: ([PlatformAssistant], Bool)?.self) { group in
            group.addTask { @MainActor in
                do {
                    let list = try await auth.listAssistants(organizationId: orgId)
                    return (list, true)
                } catch {
                    log.warning("platform fetch failed: \(String(describing: error), privacy: .public)")
                    return ([], false)
                }
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            if let first { return first }
            log.warning("platform fetch timed out")
            return ([], false)
        }
    }
}
