import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

@MainActor
final class ReturningUserRouterTests: XCTestCase {

    // MARK: - decideFast

    /// Fast path short-circuits to auto-connect when any current-env entry exists.
    func testDecideFast_currentEnvLockfileEntry_returnsAutoConnect() {
        // GIVEN a lockfile with one current-environment local entry
        let router = makeRouter(lockfile: [makeLocalAssistant(id: "a")])

        // WHEN decideFast is called
        let decision = router.decideFast()

        // THEN the router chooses to auto-connect
        XCTAssertEqual(decision, .autoConnect)
    }

    /// An empty lockfile cannot answer without a network round-trip.
    func testDecideFast_emptyLockfile_returnsNil() {
        // GIVEN an empty lockfile
        // WHEN decideFast is called
        // THEN the fast path is inconclusive
        XCTAssertNil(makeRouter(lockfile: []).decideFast())
    }

    /// Cross-environment managed entries cannot be connected to on this build.
    func testDecideFast_onlyCrossEnvironmentEntries_returnsNil() {
        // GIVEN a lockfile whose only entry is a managed assistant from another env
        let router = makeRouter(lockfile: [makeCrossEnvironmentAssistant(id: "a")])

        // WHEN decideFast is called
        // THEN the fast path is inconclusive and the platform needs to confirm
        XCTAssertNil(router.decideFast())
    }

    // MARK: - decide(for:)

    /// An authoritatively empty landscape escalates to the hosting picker.
    func testDecide_emptyLandscape_returnsShowHostingPicker() {
        // GIVEN a landscape where the platform was consulted and returned nothing
        let l = landscape(platformConsulted: true)

        // WHEN decide is called
        // THEN the router asks for the hosting picker
        XCTAssertEqual(makeRouter().decide(for: l), .showHostingPicker)
    }

    func testDecide_singleLocalAssistant_returnsAutoConnect() {
        // GIVEN a single local lockfile entry with the platform consulted
        let l = landscape(lockfile: [makeLocalAssistant(id: "a")], platformConsulted: true)

        // WHEN decide is called
        // THEN the router auto-connects
        XCTAssertEqual(makeRouter().decide(for: l), .autoConnect)
    }

    func testDecide_singleManagedAssistantWithPlatformConsulted_returnsAutoConnect() {
        // GIVEN a managed lockfile entry that also appears in the platform list
        let l = landscape(
            lockfile: [makeManagedAssistant(id: "a")],
            platform: [PlatformAssistant(id: "a")],
            platformConsulted: true
        )

        // WHEN decide is called
        // THEN the router auto-connects
        XCTAssertEqual(makeRouter().decide(for: l), .autoConnect)
    }

    func testDecide_multipleAssistants_returnsAutoConnect() {
        // GIVEN a mix of local lockfile entries and platform assistants
        let l = landscape(
            lockfile: [makeLocalAssistant(id: "a"), makeLocalAssistant(id: "b")],
            platform: [PlatformAssistant(id: "c")],
            platformConsulted: true
        )

        // WHEN decide is called
        // THEN the router auto-connects; the multi-assistant picker is a later PR
        XCTAssertEqual(makeRouter().decide(for: l), .autoConnect)
    }

    /// A failed platform fetch must not erase trust in the lockfile.
    func testDecide_platformUnreachableWithLockfileEntries_returnsAutoConnect() {
        // GIVEN the platform fetch failed but the lockfile has a managed entry
        let l = landscape(lockfile: [makeManagedAssistant(id: "a")], platformConsulted: false)

        // WHEN decide is called
        // THEN we still auto-connect using the lockfile
        XCTAssertEqual(makeRouter().decide(for: l), .autoConnect)
    }

    func testDecide_platformUnreachableWithEmptyLockfile_returnsShowHostingPicker() {
        // GIVEN both sources are empty
        let l = landscape(platformConsulted: false)

        // WHEN decide is called
        // THEN the router escalates to the hosting picker
        XCTAssertEqual(makeRouter().decide(for: l), .showHostingPicker)
    }

    /// The platform list is authoritative for managed entries once consulted.
    func testDecide_deduplicatesManagedLockfileWithPlatformList() {
        // GIVEN the same managed assistant shows up in both sources
        let l = landscape(
            lockfile: [makeManagedAssistant(id: "shared")],
            platform: [PlatformAssistant(id: "shared")],
            platformConsulted: true
        )

        // WHEN decide is called
        // THEN totalCount counts the entry exactly once
        XCTAssertEqual(l.totalCount, 1)
        XCTAssertEqual(makeRouter().decide(for: l), .autoConnect)
    }

    /// With no org id the platform cannot be consulted; lockfile stands alone.
    func testDecide_noOrgIdTrustsLockfileAlone() {
        // GIVEN the platform was not consulted (e.g. no connected org id)
        let l = landscape(
            lockfile: [makeManagedAssistant(id: "a"), makeLocalAssistant(id: "b")],
            platformConsulted: false
        )

        // WHEN decide is called
        // THEN both managed and local lockfile entries are counted
        XCTAssertEqual(l.totalCount, 2)
        XCTAssertEqual(makeRouter().decide(for: l), .autoConnect)
    }

    // MARK: - Landscape invariants

    func testTotalCount_excludesCrossEnvironmentLockfileEntries() {
        // GIVEN a cross-env managed entry alongside a local entry, platform unconsulted
        let l = landscape(
            lockfile: [makeCrossEnvironmentAssistant(id: "other-env"), makeLocalAssistant(id: "local")],
            platformConsulted: false
        )

        // WHEN the landscape is inspected
        // THEN only the current-environment entry is counted
        XCTAssertEqual(l.totalCount, 1)
        XCTAssertEqual(l.currentEnvironmentLockfileAssistants.map(\.assistantId), ["local"])
    }

    func testLocalLockfileEntriesAreAlwaysCurrentEnvironment() {
        // GIVEN a local lockfile entry
        let local = makeLocalAssistant(id: "a")

        // WHEN the environment flags are inspected
        // THEN it is always considered current-env regardless of build target
        XCTAssertTrue(local.isCurrentEnvironment)
        XCTAssertFalse(local.isManaged)
    }

    // MARK: - Fixtures

    private func makeRouter(lockfile: [LockfileAssistant] = []) -> ReturningUserRouter {
        ReturningUserRouter(
            lockfileProvider: { lockfile },
            organizationIdProvider: { nil },
            authServiceProvider: { nil }
        )
    }

    private func landscape(
        lockfile: [LockfileAssistant] = [],
        platform: [PlatformAssistant] = [],
        platformConsulted: Bool
    ) -> AssistantLandscape {
        AssistantLandscape(
            lockfileAssistants: lockfile,
            platformAssistants: platform,
            platformWasConsulted: platformConsulted
        )
    }

    private func makeLocalAssistant(id: String) -> LockfileAssistant {
        makeLockfileAssistant(id: id, cloud: "local", runtimeUrl: nil)
    }

    private func makeManagedAssistant(id: String) -> LockfileAssistant {
        // No runtimeUrl → isCurrentEnvironment short-circuits to true, matching
        // what the bootstrap writes for managed entries in this build env.
        makeLockfileAssistant(id: id, cloud: "vellum", runtimeUrl: nil)
    }

    private func makeCrossEnvironmentAssistant(id: String) -> LockfileAssistant {
        // Managed entry tagged to a different platform origin — isCurrentEnvironment
        // filters it out of routing decisions.
        makeLockfileAssistant(id: id, cloud: "vellum", runtimeUrl: "https://cross-environment.example.com")
    }

    private func makeLockfileAssistant(id: String, cloud: String, runtimeUrl: String?) -> LockfileAssistant {
        LockfileAssistant(
            assistantId: id,
            runtimeUrl: runtimeUrl,
            bearerToken: nil,
            cloud: cloud,
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
}
