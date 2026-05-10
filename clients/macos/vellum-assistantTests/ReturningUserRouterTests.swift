import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

@MainActor
final class ReturningUserRouterTests: XCTestCase {

    // MARK: - Fixtures

    private func makeLocalAssistant(id: String = "local-1") -> LockfileAssistant {
        LockfileAssistant(
            assistantId: id, runtimeUrl: nil, bearerToken: nil,
            cloud: "local", project: nil, region: nil, zone: nil,
            instanceId: nil, hatchedAt: nil, baseDataDir: nil,
            gatewayPort: nil, instanceDir: nil
        )
    }

    private func makeManagedAssistant(id: String = "managed-1") -> LockfileAssistant {
        LockfileAssistant(
            assistantId: id,
            runtimeUrl: VellumEnvironment.resolvedPlatformURL,
            bearerToken: nil, cloud: "vellum", project: nil,
            region: nil, zone: nil, instanceId: nil, hatchedAt: nil,
            baseDataDir: nil, gatewayPort: nil, instanceDir: nil
        )
    }

    private func makePlatformAssistant(id: String = "platform-1") -> PlatformAssistant {
        PlatformAssistant(id: id, name: "Test")
    }

    private func makeRouter(
        lockfile: [LockfileAssistant] = [],
        orgId: String? = nil,
        platformResult: Result<[PlatformAssistant], Error>? = nil,
        resolveOrgResult: Result<String, Error>? = nil,
        multiAssistantFlag: Bool = false
    ) -> ReturningUserRouter {
        // Build a mock auth service if either the list result OR an explicit
        // resolveOrg result is supplied. This lets tests exercise the
        // "auth service present but no cached org ID" path.
        let mockAuth: MockAuthService? = (platformResult != nil || resolveOrgResult != nil)
            ? MockAuthService(
                listResult: platformResult ?? .success([]),
                resolveOrgResult: resolveOrgResult ?? .failure(StubError.notStubbed)
            )
            : nil
        return ReturningUserRouter(
            organizationIdProvider: { orgId },
            authServiceProvider: { mockAuth },
            lockfileLoader: { lockfile },
            multiAssistantFlagProvider: { multiAssistantFlag }
        )
    }

    private enum StubError: Error { case notStubbed }

    // MARK: - decideFast

    func testDecideFastReturnsAutoConnectWhenCurrentEnvEntryExists() {
        let router = makeRouter(lockfile: [makeLocalAssistant()])
        XCTAssertEqual(router.decideFast(), .autoConnect)
    }

    func testDecideFastReturnsNilWhenLockfileIsEmpty() {
        let router = makeRouter()
        XCTAssertNil(router.decideFast())
    }

    func testDecideFastReturnAutoConnectForManagedCurrentEnv() {
        let router = makeRouter(lockfile: [makeManagedAssistant()])
        XCTAssertEqual(router.decideFast(), .autoConnect)
    }

    func testDecideFastShowsPickerForMultipleLockfileEntries() {
        let router = makeRouter(lockfile: [makeLocalAssistant(), makeManagedAssistant()])
        XCTAssertEqual(router.decideFast(), .showAssistantPicker)
    }

    func testDecideFastShowsPickerForSingleEntryWithMultiFlag() {
        let router = makeRouter(lockfile: [makeLocalAssistant()], multiAssistantFlag: true)
        XCTAssertEqual(router.decideFast(), .showAssistantPicker)
    }

    // MARK: - decide(for:)

    func testDecideShowsHostingPickerWhenZeroAssistants() {
        let router = makeRouter()
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [], platformAssistants: [],
            platformWasConsulted: true
        )
        XCTAssertEqual(router.decide(for: landscape), .showHostingPicker)
    }

    func testDecideAutoConnectsWithOneLocalAssistant() {
        let local = makeLocalAssistant()
        let router = makeRouter()
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [local], platformAssistants: [],
            platformWasConsulted: true
        )
        XCTAssertEqual(router.decide(for: landscape), .autoConnect)
    }

    func testDecideAutoConnectsWithOnePlatformAssistant() {
        let router = makeRouter()
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [], platformAssistants: [makePlatformAssistant()],
            platformWasConsulted: true
        )
        XCTAssertEqual(router.decide(for: landscape), .autoConnect)
    }

    func testDecideAutoConnectsWithMultipleAssistantsWhenFlagOff() {
        let router = makeRouter(multiAssistantFlag: false)
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [makeLocalAssistant()],
            platformAssistants: [makePlatformAssistant()],
            platformWasConsulted: true
        )
        XCTAssertEqual(router.decide(for: landscape), .showAssistantPicker)
    }

    // MARK: - Assistant picker routing

    func testDecideShowsPickerForMultipleAssistants() {
        let router = makeRouter(multiAssistantFlag: false)
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [makeLocalAssistant(), makeLocalAssistant(id: "local-2")],
            platformAssistants: [],
            platformWasConsulted: true
        )
        XCTAssertEqual(router.decide(for: landscape), .showAssistantPicker)
    }

    func testDecideShowsPickerForSingleAssistantWithMultiFlag() {
        let router = makeRouter(multiAssistantFlag: true)
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [makeLocalAssistant()],
            platformAssistants: [],
            platformWasConsulted: true
        )
        XCTAssertEqual(router.decide(for: landscape), .showAssistantPicker)
    }

    func testDecideAutoConnectsForSingleAssistantWithoutMultiFlag() {
        let router = makeRouter(multiAssistantFlag: false)
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [makeLocalAssistant()],
            platformAssistants: [],
            platformWasConsulted: true
        )
        XCTAssertEqual(router.decide(for: landscape), .autoConnect)
    }

    // MARK: - Deduplication

    func testManagedLockfileEntryNotDoubleCountedWhenPlatformConsulted() {
        let router = makeRouter()
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [makeManagedAssistant(id: "m-1")],
            platformAssistants: [makePlatformAssistant(id: "m-1")],
            platformWasConsulted: true
        )
        // Managed lockfile entry excluded when platform was consulted;
        // only the platform entry counts → total = 1, not 2.
        XCTAssertEqual(landscape.totalCount, 1)
        XCTAssertEqual(router.decide(for: landscape), .autoConnect)
    }

    func testStaleManagedLockfileEntryShowsHostingPickerWhenPlatformConsulted() {
        let router = makeRouter()
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [makeManagedAssistant(id: "stale-managed")],
            platformAssistants: [],
            platformWasConsulted: true
        )
        // The platform list is authoritative for managed assistants once
        // consulted. If the only managed lockfile entry is absent from the
        // platform list, treat it as stale and send the user to setup.
        XCTAssertEqual(landscape.totalCount, 0)
        XCTAssertEqual(router.decide(for: landscape), .showHostingPicker)
    }

    func testManagedLockfileEntryCountedWhenPlatformNotConsulted() {
        let router = makeRouter()
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [makeManagedAssistant()],
            platformAssistants: [],
            platformWasConsulted: false
        )
        XCTAssertEqual(landscape.totalCount, 1)
        XCTAssertEqual(router.decide(for: landscape), .autoConnect)
    }

    // MARK: - Platform fallback

    func testPlatformUnreachableWithLockfileEntryAutoConnects() async throws {
        let router = makeRouter(
            lockfile: [makeLocalAssistant()],
            orgId: "org-1",
            platformResult: .failure(URLError(.timedOut))
        )
        let decision = try await router.route()
        XCTAssertEqual(decision, .autoConnect)
    }

    func testPlatformUnreachableEmptyLockfileShowsHostingPicker() async throws {
        let router = makeRouter(
            lockfile: [],
            orgId: "org-1",
            platformResult: .failure(URLError(.timedOut))
        )
        let decision = try await router.route()
        XCTAssertEqual(decision, .showHostingPicker)
    }

    func testNoOrgIdAndNoAuthServiceSkipsPlatformFetch() async throws {
        // No auth service injected → router can't even attempt to resolve
        // an org, so the platform fetch is skipped entirely.
        let router = makeRouter(lockfile: [makeLocalAssistant()], orgId: nil)
        let landscape = try await router.fetchLandscape()
        XCTAssertFalse(landscape.platformWasConsulted)
        XCTAssertEqual(landscape.totalCount, 1)
    }

    func testNoCachedOrgResolvesViaAuthService() async throws {
        // Reproduces the post-login race that broke the staging DMG even
        // after #29855 landed: AuthManager flips `state = .authenticated`
        // and SwiftUI observers spawn Tasks that call fetchLandscape()
        // *before* `resolveOrganizationIdAfterAuth` has persisted
        // `connectedOrganizationId` to UserDefaults. The router should
        // resolve the org itself via the auth service rather than silently
        // skipping the platform fetch and dumping the user at the hosting
        // selector.
        let router = makeRouter(
            lockfile: [],
            orgId: nil,
            platformResult: .success([makePlatformAssistant(id: "p-1")]),
            resolveOrgResult: .success("org-resolved")
        )
        let landscape = try await router.fetchLandscape()
        XCTAssertTrue(landscape.platformWasConsulted)
        XCTAssertEqual(landscape.platformAssistants.map(\.id), ["p-1"])
    }

    func testNoCachedOrgAndResolveFailsSkipsPlatformFetch() async throws {
        // If org resolution itself fails (transient network error), we
        // must NOT report platformWasConsulted=true with an empty list —
        // that would let LockfileReconciler wipe legitimate managed entries.
        let router = makeRouter(
            lockfile: [makeManagedAssistant()],
            orgId: nil,
            resolveOrgResult: .failure(URLError(.timedOut))
        )
        let landscape = try await router.fetchLandscape()
        XCTAssertFalse(landscape.platformWasConsulted)
        XCTAssertEqual(landscape.lockfileAssistants.count, 1)
    }

    func testCachedOrgIdSkipsResolveCall() async throws {
        // When the org ID is already cached we should NOT call resolveOrg
        // again — the resolve mock is wired to fail, so reaching it would
        // surface as platformWasConsulted=false, not the .success below.
        let router = makeRouter(
            lockfile: [],
            orgId: "org-cached",
            platformResult: .success([makePlatformAssistant(id: "p-1")]),
            resolveOrgResult: .failure(URLError(.timedOut))
        )
        let landscape = try await router.fetchLandscape()
        XCTAssertTrue(landscape.platformWasConsulted)
        XCTAssertEqual(landscape.platformAssistants.map(\.id), ["p-1"])
    }

    // MARK: - Landscape helpers

    func testLocalAssistantsAlwaysCurrentEnvironment() {
        let local = makeLocalAssistant()
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [local], platformAssistants: [],
            platformWasConsulted: true
        )
        XCTAssertEqual(landscape.currentEnvironmentLockfileAssistants.count, 1)
        XCTAssertEqual(landscape.currentEnvironmentLocalLockfileAssistants.count, 1)
    }

    func testTotalCountExcludesCrossEnvironmentEntries() {
        // A managed assistant with a mismatched runtimeUrl is cross-environment
        let crossEnv = LockfileAssistant(
            assistantId: "cross-1",
            runtimeUrl: "https://other-platform.example.com",
            bearerToken: nil, cloud: "vellum", project: nil,
            region: nil, zone: nil, instanceId: nil, hatchedAt: nil,
            baseDataDir: nil, gatewayPort: nil, instanceDir: nil
        )
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [crossEnv], platformAssistants: [],
            platformWasConsulted: false
        )
        XCTAssertEqual(landscape.totalCount, 0)
    }
}

// MARK: - Mock

@MainActor
private final class MockAuthService: ManagedAssistantBootstrapAuthServicing {
    private let listResult: Result<[PlatformAssistant], Error>
    private let resolveOrgResult: Result<String, Error>

    init(
        listResult: Result<[PlatformAssistant], Error>,
        resolveOrgResult: Result<String, Error>
    ) {
        self.listResult = listResult
        self.resolveOrgResult = resolveOrgResult
    }

    func listAssistants(organizationId: String) async throws -> [PlatformAssistant] {
        try listResult.get()
    }

    func resolveOrganizationId() async throws -> String {
        try resolveOrgResult.get()
    }

    // Unused by router — stubs only.
    func getOrganizations() async throws -> [PlatformOrganization] { [] }
    func getAssistant(id: String, organizationId: String) async throws -> PlatformAssistantResult {
        fatalError("Not used by ReturningUserRouter")
    }
    func hatchAssistant(
        organizationId: String, name: String?, description: String?,
        anthropicApiKey: String?,
        mode: HatchAssistantMode
    ) async throws -> HatchAssistantResult {
        fatalError("Not used by ReturningUserRouter")
    }
}
