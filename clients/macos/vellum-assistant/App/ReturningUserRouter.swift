import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ReturningUserRouter")

/// Post-authentication routing for returning users.
///
/// Centralizes the "what should happen after auth" decision so call sites
/// (`AppDelegate+AuthLifecycle`, `ReauthView`, etc.) share one source of
/// truth instead of each re-deriving the branch from the lockfile alone.
///
/// The router fetches the assistant landscape from two sources in parallel —
/// the local lockfile and the platform server — and keeps them as separate,
/// read-only views. It never reconciles or merges the underlying data; the
/// lockfile and the platform list remain independent sources of truth.
///
/// This is PR 1 of ATL-173. Only two outcomes are live:
///   - `showHostingPicker`: 0 assistants visible → run the onboarding
///     hosting picker so the user chooses their hosting type (local,
///     managed, or remote) rather than silently hatching one for them
///   - `autoConnect`: 1 assistant visible without the multi-assistant
///     entitlement → auto-connect, preserving the existing single-assistant
///     returning-user experience
///
/// Multi-assistant paths (1 assistant + multi-platform flag, or N>1) fall
/// through to `autoConnect` with a TODO comment so users are never stuck on
/// startup. PR 2 will replace that fallback with a picker UI.
@MainActor
final class ReturningUserRouter {

    /// Read-only presentation-layer snapshot of the two sources the router
    /// consults. Callers that need to render (e.g. the future picker) read
    /// the two lists side by side without attempting to reconcile them.
    ///
    /// Not `Sendable` because `LockfileAssistant` is not declared
    /// `Sendable`. This is fine for PR 1 because the router is
    /// `@MainActor` and the landscape never crosses an isolation
    /// boundary.
    struct AssistantLandscape {
        /// Every entry in the lockfile, regardless of environment. Callers
        /// that need connectable-only entries use
        /// ``currentEnvironmentLockfileAssistants``.
        let lockfileAssistants: [LockfileAssistant]
        /// Managed assistants visible to the caller on the platform. Empty
        /// both when the platform authoritatively reports zero assistants
        /// and when it was not consulted at all; ``platformWasConsulted``
        /// distinguishes the two.
        let platformAssistants: [PlatformAssistant]
        /// Whether the platform list endpoint was actually consulted (i.e.
        /// the caller had an organization id and the fetch completed
        /// successfully). When `false`, ``platformAssistants`` is not
        /// authoritative — the router must fall back to trusting the
        /// lockfile rather than treating empty as "zero assistants".
        let platformWasConsulted: Bool

        /// Lockfile entries that belong to the current build's platform
        /// environment. Cross-environment managed entries (e.g. dev
        /// assistants in a production build) are not auto-connectable and
        /// therefore excluded from routing counts.
        var currentEnvironmentLockfileAssistants: [LockfileAssistant] {
            lockfileAssistants.filter { $0.isCurrentEnvironment }
        }

        /// Local lockfile entries in the current environment — i.e.
        /// non-managed hosting types (local, docker, apple-container,
        /// remote). The lockfile is the source of truth for these
        /// regardless of what the platform reports.
        var currentEnvironmentLocalLockfileAssistants: [LockfileAssistant] {
            currentEnvironmentLockfileAssistants.filter { !$0.isManaged }
        }

        /// Total count used for routing decisions.
        ///
        /// When the platform was consulted, the platform list is the
        /// authoritative source for managed assistants: the count is
        /// `local lockfile entries + platform entries`, which discounts
        /// managed lockfile entries that no longer exist on the platform
        /// (stale entries) and avoids double-counting managed assistants
        /// that appear in both sources.
        ///
        /// When the platform was not consulted (no organization id, or the
        /// fetch failed / timed out), we fall back to trusting every
        /// current-environment lockfile entry. Demoting an authenticated
        /// returning user to the hosting picker because of a network blip
        /// would be strictly worse than continuing to trust local state.
        var totalCount: Int {
            if platformWasConsulted {
                return currentEnvironmentLocalLockfileAssistants.count + platformAssistants.count
            }
            return currentEnvironmentLockfileAssistants.count + platformAssistants.count
        }
    }

    /// The decision the router produces for a given landscape.
    enum RoutingDecision: Sendable, Equatable {
        /// Show the onboarding hosting picker so the user chooses their
        /// hosting type. Used when the user has no visible assistants
        /// anywhere — we never silently hatch on their behalf.
        case showHostingPicker
        /// Auto-connect to the single visible assistant. Also returned as
        /// the temporary fallback for multi-assistant landscapes until the
        /// picker ships in PR 2.
        case autoConnect
    }

    typealias MultiAssistantChecker = @MainActor () -> Bool
    typealias OrganizationIdProvider = @MainActor () -> String?
    /// Returns the platform assistant list, or `nil` when the fetch could
    /// not complete (network error, HTTP failure). The distinction matters
    /// for stale-lockfile detection: an empty array means "the platform
    /// authoritatively has zero assistants", whereas `nil` means "we don't
    /// know" and the router must fall back to trusting the lockfile.
    typealias PlatformListProvider = @MainActor (String) async -> [PlatformAssistant]?
    typealias LockfileProvider = @MainActor () -> [LockfileAssistant]

    private let multiAssistantChecker: MultiAssistantChecker
    private let organizationIdProvider: OrganizationIdProvider
    private let platformListProvider: PlatformListProvider
    private let lockfileProvider: LockfileProvider

    init(
        multiAssistantChecker: @escaping MultiAssistantChecker = {
            AssistantFeatureFlagResolver.isEnabled("multi-platform-assistant")
        },
        organizationIdProvider: @escaping OrganizationIdProvider = {
            UserDefaults.standard.string(forKey: AuthService.connectedOrganizationIdKey)
        },
        platformListProvider: @escaping PlatformListProvider = { orgId in
            // Bound the platform fetch so a slow or unreachable server
            // doesn't hold up the app launch on the cold-start path.
            // `URLSession.shared`'s default timeout is 60s, which is
            // unacceptable for a blocking decision the UI waits on.
            //
            // Returning `nil` on failure (vs an empty array) tells the
            // router to treat the platform as "not consulted" so a
            // flaky network doesn't demote a returning user to the
            // hosting picker. Only an authoritative empty response
            // (HTTP 200 with `[]`) drives stale-lockfile detection.
            enum PlatformFetchOutcome: Sendable {
                case result([PlatformAssistant]?)
                case timeout
            }
            return await withTaskGroup(of: PlatformFetchOutcome.self) { group in
                group.addTask {
                    do {
                        let list = try await AuthService.shared.listAssistants(organizationId: orgId)
                        return .result(list)
                    } catch {
                        log.warning("Platform list fetch failed, treating as unconsulted: \(error.localizedDescription, privacy: .public)")
                        return .result(nil)
                    }
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 5 * 1_000_000_000)
                    return .timeout
                }
                defer { group.cancelAll() }
                for await outcome in group {
                    switch outcome {
                    case .result(let list):
                        return list
                    case .timeout:
                        log.warning("Platform list fetch exceeded 5s budget, treating as unconsulted")
                        return nil
                    }
                }
                return nil
            }
        },
        lockfileProvider: @escaping LockfileProvider = {
            LockfileAssistant.loadAll()
        }
    ) {
        self.multiAssistantChecker = multiAssistantChecker
        self.organizationIdProvider = organizationIdProvider
        self.platformListProvider = platformListProvider
        self.lockfileProvider = lockfileProvider
    }

    /// Fetch the lockfile and platform lists in parallel and return a
    /// snapshot. Either source may be empty; both sources are kept separate
    /// so the caller can render them side by side without implicit merging.
    func fetchLandscape() async -> AssistantLandscape {
        let orgId = organizationIdProvider()
        let lockfile = lockfileProvider()

        let platform: [PlatformAssistant]
        let platformWasConsulted: Bool
        if let orgId, !orgId.isEmpty, let fetched = await platformListProvider(orgId) {
            platform = fetched
            platformWasConsulted = true
        } else {
            platform = []
            platformWasConsulted = false
        }

        return AssistantLandscape(
            lockfileAssistants: lockfile,
            platformAssistants: platform,
            platformWasConsulted: platformWasConsulted
        )
    }

    /// Synchronous fast path for hot startup paths.
    ///
    /// Returns a decision when the lockfile alone is decisive, so callers
    /// like `startAuthenticatedFlow` don't have to block on the platform
    /// `listAssistants` network call before the app window opens.
    ///
    /// The fast path intentionally only fires for local (non-managed)
    /// lockfile entries: local assistants are authoritative on-disk, so
    /// their presence alone is decisive. Managed entries can be stale —
    /// the assistant may have been deleted on the platform — and require
    /// the async `route()` path to consult `listAssistants` and detect
    /// staleness; otherwise a returning user with only a stale managed
    /// entry would auto-connect to a nonexistent assistant instead of
    /// landing on the hosting picker.
    ///
    /// PR 2's picker will call `fetchLandscape()` directly when it needs
    /// to render platform-only entries; the fast path stays focused on
    /// the cold-start decision.
    func decideFast() -> RoutingDecision? {
        let hasLocalConnectable = lockfileProvider().contains { $0.isCurrentEnvironment && !$0.isManaged }
        return hasLocalConnectable ? .autoConnect : nil
    }

    /// Pure decision function so callers and tests can exercise the
    /// routing table without hitting disk or the network.
    func decide(for landscape: AssistantLandscape) -> RoutingDecision {
        let count = landscape.totalCount
        if count == 0 {
            return .showHostingPicker
        }

        let hasMultiAssistant = multiAssistantChecker()
        if count == 1 && !hasMultiAssistant {
            return .autoConnect
        }

        // TODO (ATL-173 PR 2): present `AssistantPickerView` for
        //   - 1 assistant + multi-platform-assistant flag
        //   - N > 1 assistants (any flag state)
        // Until the picker lands, fall through to `autoConnect` so returning
        // users are never stuck on startup. The downstream auto-connect path
        // reads the lockfile's `activeAssistant` hint (or falls back to the
        // latest entry), which gives N-assistant users deterministic behavior.
        return .autoConnect
    }

    /// Convenience: fetch the landscape and return the decision. Callers
    /// that also need to render the landscape (e.g. the picker in PR 2)
    /// should invoke ``fetchLandscape()`` and ``decide(for:)`` separately
    /// so the fetched data can be reused.
    func route() async -> RoutingDecision {
        decide(for: await fetchLandscape())
    }
}
