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
        platformResult: Result<[PlatformAssistant], Error>? = nil
    ) -> ReturningUserRouter {
        let mockAuth: MockAuthService? = platformResult.map { result in
            MockAuthService(listResult: result)
        }
        return ReturningUserRouter(
            organizationIdProvider: { orgId },
            authServiceProvider: { mockAuth },
            lockfileLoader: { lockfile }
        )
    }

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

    func testDecideAutoConnectsWithMultipleAssistants() {
        let router = makeRouter()
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [makeLocalAssistant()],
            platformAssistants: [makePlatformAssistant()],
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

    func testPlatformUnreachableWithLockfileEntryAutoConnects() async {
        let router = makeRouter(
            lockfile: [makeLocalAssistant()],
            orgId: "org-1",
            platformResult: .failure(URLError(.timedOut))
        )
        let decision = await router.route()
        XCTAssertEqual(decision, .autoConnect)
    }

    func testPlatformUnreachableEmptyLockfileShowsHostingPicker() async {
        let router = makeRouter(
            lockfile: [],
            orgId: "org-1",
            platformResult: .failure(URLError(.timedOut))
        )
        let decision = await router.route()
        XCTAssertEqual(decision, .showHostingPicker)
    }

    func testNoOrgIdSkipsPlatformFetch() async {
        let router = makeRouter(lockfile: [makeLocalAssistant()], orgId: nil)
        let landscape = await router.fetchLandscape()
        XCTAssertFalse(landscape.platformWasConsulted)
        XCTAssertEqual(landscape.totalCount, 1)
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

    init(listResult: Result<[PlatformAssistant], Error>) {
        self.listResult = listResult
    }

    func listAssistants(organizationId: String) async throws -> [PlatformAssistant] {
        try listResult.get()
    }

    // Unused by router — stubs only.
    func getOrganizations() async throws -> [PlatformOrganization] { [] }
    func resolveOrganizationId() async throws -> String { "" }
    func getAssistant(id: String, organizationId: String) async throws -> PlatformAssistantResult {
        fatalError("Not used by ReturningUserRouter")
    }
    func hatchAssistant(
        organizationId: String, name: String?, description: String?,
        anthropicApiKey: String?
    ) async throws -> HatchAssistantResult {
        fatalError("Not used by ReturningUserRouter")
    }
}
