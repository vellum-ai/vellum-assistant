import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

@MainActor
final class ReturningUserRouterTests: XCTestCase {

    // MARK: - Fixtures

    private func makeLocalAssistant(id: String = "local-1") -> LockfileAssistant {
        LockfileAssistant(
            assistantId: id,
            runtimeUrl: nil,
            bearerToken: nil,
            cloud: "local",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: nil,
            baseDataDir: nil,
            gatewayPort: nil,
            instanceDir: nil
        )
    }

    /// A managed lockfile entry whose `runtimeUrl` matches the current
    /// build's platform URL so `isCurrentEnvironment` returns `true`.
    /// Used to exercise the stale-managed-lockfile detection path.
    private func makeManagedAssistant(id: String = "managed-1") -> LockfileAssistant {
        LockfileAssistant(
            assistantId: id,
            runtimeUrl: VellumEnvironment.resolvedPlatformURL,
            bearerToken: nil,
            cloud: "vellum",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: nil,
            baseDataDir: nil,
            gatewayPort: nil,
            instanceDir: nil
        )
    }

    private func makePlatformAssistant(id: String = "platform-1") -> PlatformAssistant {
        PlatformAssistant(id: id, name: "Platform \(id)")
    }

    /// Builds a router backed by in-memory providers. Pass
    /// `platform: nil` to simulate a fetch that failed or timed out (the
    /// platform was not consulted authoritatively); pass `platform: []` to
    /// simulate a successful fetch that returned zero assistants.
    private func makeRouter(
        lockfile: [LockfileAssistant] = [],
        platform: [PlatformAssistant]? = [],
        hasMultiAssistant: Bool = false,
        organizationId: String? = "org-1"
    ) -> ReturningUserRouter {
        ReturningUserRouter(
            multiAssistantChecker: { hasMultiAssistant },
            organizationIdProvider: { organizationId },
            platformListProvider: { _ in platform },
            lockfileProvider: { lockfile }
        )
    }

    // MARK: - decide(for:)

    /// A user with no assistants anywhere must be sent to the onboarding
    /// hosting picker so they choose their hosting type rather than have
    /// one silently hatched for them.
    func testZeroAssistantsRoutesToHostingPicker() {
        // GIVEN a router with no lockfile entries and an authoritative
        // empty platform list
        let router = makeRouter()
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [],
            platformAssistants: [],
            platformWasConsulted: true
        )

        // WHEN the router decides
        let decision = router.decide(for: landscape)

        // THEN it routes to the onboarding hosting picker
        XCTAssertEqual(decision, .showHostingPicker)
    }

    /// When `ReauthView` runs the router and the platform authoritatively
    /// reports zero assistants, a managed lockfile entry left over from a
    /// deleted assistant must not keep the user on auto-connect. The whole
    /// point of routing re-auth through the async `route()` path is to
    /// detect this stale state and drop the user into the hosting picker
    /// instead of silently re-hatching a managed assistant.
    func testStaleManagedLockfileWithZeroPlatformAssistantsRoutesToHostingPicker() {
        // GIVEN one managed lockfile entry
        let router = makeRouter()
        // AND the platform was consulted and authoritatively returned empty
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [makeManagedAssistant()],
            platformAssistants: [],
            platformWasConsulted: true
        )

        // WHEN the router decides
        let decision = router.decide(for: landscape)

        // THEN the managed entry is treated as stale and the user is sent
        // to the hosting picker rather than auto-connecting to a deleted
        // assistant.
        XCTAssertEqual(decision, .showHostingPicker)
    }

    /// When the platform was not consulted (missing org id, fetch failure,
    /// or timeout) we have no way to verify managed entries, and demoting
    /// an authenticated returning user to the hosting picker based on a
    /// network blip would be strictly worse than trusting local state.
    func testManagedLockfileWithUnconsultedPlatformAutoConnects() {
        // GIVEN one managed lockfile entry
        let router = makeRouter()
        // AND the platform was not consulted authoritatively
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [makeManagedAssistant()],
            platformAssistants: [],
            platformWasConsulted: false
        )

        // WHEN the router decides
        let decision = router.decide(for: landscape)

        // THEN it auto-connects, trusting the lockfile as a fallback
        XCTAssertEqual(decision, .autoConnect)
    }

    /// A managed assistant that appears in both the lockfile and the
    /// platform list must count as one, not two. Otherwise a single
    /// managed user would be routed down the multi-assistant path once
    /// the picker lands in PR 2.
    func testManagedAssistantInBothSourcesCountsOnce() {
        // GIVEN one managed lockfile entry
        let router = makeRouter(hasMultiAssistant: false)
        // AND the platform authoritatively reports one assistant
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [makeManagedAssistant()],
            platformAssistants: [makePlatformAssistant()],
            platformWasConsulted: true
        )

        // WHEN the router decides
        let decision = router.decide(for: landscape)

        // THEN it auto-connects (count is 1, not 2)
        XCTAssertEqual(decision, .autoConnect)
    }

    /// A returning user with a single lockfile assistant and no multi-assistant
    /// entitlement should auto-connect silently — this is the critical
    /// "don't regress the single-user experience" case.
    func testSingleLocalAssistantWithoutMultiFlagAutoConnects() {
        // GIVEN one local lockfile entry and the multi-assistant flag disabled
        let router = makeRouter(hasMultiAssistant: false)
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [makeLocalAssistant()],
            platformAssistants: [],
            platformWasConsulted: true
        )

        // WHEN the router decides
        let decision = router.decide(for: landscape)

        // THEN it auto-connects
        XCTAssertEqual(decision, .autoConnect)
    }

    /// A platform-only assistant (visible on the server but not yet in the
    /// lockfile) still counts toward the auto-connect threshold.
    func testSinglePlatformOnlyAssistantWithoutMultiFlagAutoConnects() {
        // GIVEN one platform assistant and no lockfile entries
        let router = makeRouter(hasMultiAssistant: false)
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [],
            platformAssistants: [makePlatformAssistant()],
            platformWasConsulted: true
        )

        // WHEN the router decides
        let decision = router.decide(for: landscape)

        // THEN it auto-connects
        XCTAssertEqual(decision, .autoConnect)
    }

    /// Until PR 2 ships the picker, a single assistant with the multi-assistant
    /// flag still falls through to auto-connect so users aren't stuck.
    func testSingleAssistantWithMultiFlagFallsThroughToAutoConnectUntilPR2() {
        // GIVEN one lockfile entry
        let router = makeRouter(hasMultiAssistant: true)
        // AND the multi-assistant flag is enabled
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [makeLocalAssistant()],
            platformAssistants: [],
            platformWasConsulted: true
        )

        // WHEN the router decides
        let decision = router.decide(for: landscape)

        // THEN it falls through to auto-connect (PR 1 stub; PR 2 replaces this with the picker)
        XCTAssertEqual(decision, .autoConnect)
    }

    /// Multi-assistant landscapes also fall through to auto-connect in PR 1;
    /// the downstream `loadAssistantFromLockfile` picks either the lockfile's
    /// activeAssistant hint or the latest entry.
    func testMultipleAssistantsFallsThroughToAutoConnectUntilPR2() {
        // GIVEN multiple assistants across both sources
        let router = makeRouter(hasMultiAssistant: true)
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [makeLocalAssistant(id: "a"), makeLocalAssistant(id: "b")],
            platformAssistants: [makePlatformAssistant(id: "c")],
            platformWasConsulted: true
        )

        // WHEN the router decides
        let decision = router.decide(for: landscape)

        // THEN it falls through to auto-connect (PR 1 stub; PR 2 replaces this with the picker)
        XCTAssertEqual(decision, .autoConnect)
    }

    // MARK: - decideFast()

    /// The cold-start fast path must return a decision without touching
    /// the network whenever the lockfile already has a current-env entry.
    /// This is the invariant that keeps returning-user launch latency
    /// unchanged after the router was introduced.
    func testDecideFastReturnsAutoConnectWhenLockfileHasCurrentEnvEntry() {
        // GIVEN a lockfile with one local (current-env) assistant
        let router = makeRouter(lockfile: [makeLocalAssistant()])

        // WHEN the fast path runs
        let decision = router.decideFast()

        // THEN it decides auto-connect without any async work
        XCTAssertEqual(decision, .autoConnect)
    }

    /// When the lockfile has no current-env entries the fast path must
    /// return `nil` so the caller knows to fall through to the async
    /// `route()` and let the platform list contribute.
    func testDecideFastReturnsNilWhenLockfileIsEmpty() {
        // GIVEN an empty lockfile
        let router = makeRouter(lockfile: [])

        // WHEN the fast path runs
        let decision = router.decideFast()

        // THEN it defers to the async path
        XCTAssertNil(decision)
    }

    // MARK: - fetchLandscape()

    /// The router must surface both sources to callers without merging them.
    func testFetchLandscapeReadsLockfileAndPlatformInParallel() async {
        // GIVEN one lockfile entry and one platform entry
        let lockEntry = makeLocalAssistant()
        let platformEntry = makePlatformAssistant()
        let router = makeRouter(
            lockfile: [lockEntry],
            platform: [platformEntry]
        )

        // WHEN the caller fetches the landscape
        let landscape = await router.fetchLandscape()

        // THEN the two sources are returned side by side, unmerged
        XCTAssertEqual(landscape.lockfileAssistants.map(\.assistantId), [lockEntry.assistantId])
        // AND the platform list is unchanged
        XCTAssertEqual(landscape.platformAssistants.map(\.id), [platformEntry.id])
        // AND the platform was consulted authoritatively
        XCTAssertTrue(landscape.platformWasConsulted)
    }

    /// Without a persisted organization id there's no safe way to call the
    /// server list endpoint, so the platform list stays empty and is
    /// flagged as not consulted.
    func testFetchLandscapeSkipsPlatformListWhenOrganizationIdMissing() async {
        // GIVEN a router whose provider would record whether it was invoked
        var platformCalled = false
        let router = ReturningUserRouter(
            multiAssistantChecker: { false },
            organizationIdProvider: { nil },
            platformListProvider: { _ in
                platformCalled = true
                return [self.makePlatformAssistant()]
            },
            lockfileProvider: { [] }
        )

        // WHEN the caller fetches the landscape with no org id persisted
        let landscape = await router.fetchLandscape()

        // THEN the platform list provider was never called
        XCTAssertFalse(platformCalled, "Router should not call the platform list when no org id is persisted")
        // AND the returned landscape is empty on the platform side
        XCTAssertTrue(landscape.platformAssistants.isEmpty)
        // AND the platform is flagged as not consulted so downstream
        // routing knows to fall back to trusting the lockfile
        XCTAssertFalse(landscape.platformWasConsulted)
    }

    /// When the platform provider returns `nil` (fetch failure or
    /// timeout), the landscape must flag the platform as not consulted so
    /// the router falls back to trusting the lockfile.
    func testFetchLandscapeTreatsProviderNilAsUnconsulted() async {
        // GIVEN a router whose platform provider simulates a fetch failure
        let router = makeRouter(
            lockfile: [makeManagedAssistant()],
            platform: nil
        )

        // WHEN the caller fetches the landscape
        let landscape = await router.fetchLandscape()

        // THEN the platform list is empty
        XCTAssertTrue(landscape.platformAssistants.isEmpty)
        // AND the platform is flagged as not consulted
        XCTAssertFalse(landscape.platformWasConsulted)
    }

    // MARK: - totalCount environment filtering

    /// The routing count is derived from current-environment lockfile entries
    /// plus the platform list; cross-environment lockfile entries must not
    /// bias the 0-vs-1 threshold.
    func testCurrentEnvironmentLockfileAssistantsFilter() {
        // GIVEN a landscape containing a single local (current-environment)
        // assistant and an authoritative empty platform list
        let local = makeLocalAssistant()
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [local],
            platformAssistants: [],
            platformWasConsulted: true
        )

        // WHEN we compute the routing totals
        let total = landscape.totalCount
        let filtered = landscape.currentEnvironmentLockfileAssistants

        // THEN the single current-environment entry is the only one counted
        XCTAssertEqual(total, 1)
        // AND the filter accepts local entries (local is always current-env)
        XCTAssertEqual(filtered.count, 1)
    }
}
