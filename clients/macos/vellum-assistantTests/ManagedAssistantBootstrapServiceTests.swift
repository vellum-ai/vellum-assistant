import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

/// Tests for the bootstrap flow that uses GET /v1/assistants/active/ to ask
/// the platform for the user's currently active assistant.
///
/// Flow:
/// 1. (macOS only) If a connectedAssistantId exists, fetch directly. On 404,
///    clear the stale id and fall through.
/// 2. Call getActiveAssistant. If found, reuse it.
/// 3. If active returns 404, fall through to hatch (first-run UX).
///
/// Uses an in-memory `MockActiveAssistantIdStore` and `MockBootstrapAuthService` so the
/// tests never touch the real lockfile or `UserDefaults.standard`.
@MainActor
final class ManagedAssistantBootstrapServiceTests: XCTestCase {
    private var savedConnectedOrgId: String?

    override func setUp() {
        super.setUp()
        // `resolveOrganizationId()` reads `connectedOrganizationId` from
        // `UserDefaults.standard`; save + restore around the test rather than
        // clobber whatever the developer has locally.
        savedConnectedOrgId = UserDefaults.standard.string(forKey: "connectedOrganizationId")
        UserDefaults.standard.set("org-test", forKey: "connectedOrganizationId")
    }

    override func tearDown() {
        if let savedConnectedOrgId {
            UserDefaults.standard.set(savedConnectedOrgId, forKey: "connectedOrganizationId")
        } else {
            UserDefaults.standard.removeObject(forKey: "connectedOrganizationId")
        }
        savedConnectedOrgId = nil
        super.tearDown()
    }

    // MARK: - Stale lockfile id 404 → falls through to active lookup → reuses active

    func testStale404_reusesActiveAssistant() async throws {
        let idStore = MockActiveAssistantIdStore(storedId: "stale-id")
        let active = PlatformAssistant(id: "active-id", name: "Active")
        let auth = MockBootstrapAuthService(
            organizations: [PlatformOrganization(id: "org-test", name: "Org")],
            getAssistantResult: .notFound,
            getActiveAssistantResult: .found(active)
        )
        let service = ManagedAssistantBootstrapService(
            authService: auth,
            activeAssistantIdStore: idStore
        )

        let outcome = try await service.ensureManagedAssistant()

        XCTAssertEqual(auth.getAssistantCallCount, 1)
        XCTAssertEqual(idStore.clearCallCount, 1, "Stale ID must be cleared on 404")
        XCTAssertNil(idStore.storedId)
        XCTAssertEqual(auth.getActiveAssistantCallCount, 1, "Must query active endpoint after stale 404")
        XCTAssertEqual(auth.hatchCallCount, 0, "Found active assistant must not hatch")
        if case .reusedExisting(let a) = outcome {
            XCTAssertEqual(a.id, "active-id")
        } else {
            XCTFail("Expected reusedExisting from active lookup, got \(outcome)")
        }
    }

    // MARK: - Stale lockfile id 404 → active also 404 → falls through to hatch

    func testStale404_noActive_fallsThroughToHatch() async throws {
        let idStore = MockActiveAssistantIdStore(storedId: "stale-id")
        let auth = MockBootstrapAuthService(
            organizations: [PlatformOrganization(id: "org-test", name: "Org")],
            getAssistantResult: .notFound,
            getActiveAssistantResult: .notFound
        )
        let service = ManagedAssistantBootstrapService(
            authService: auth,
            activeAssistantIdStore: idStore
        )

        let outcome = try await service.ensureManagedAssistant()

        XCTAssertEqual(idStore.clearCallCount, 1)
        XCTAssertEqual(auth.getActiveAssistantCallCount, 1)
        XCTAssertEqual(auth.hatchCallCount, 1, "404 from active must fall through to hatch (first-run UX)")
        if case .createdNew(let a) = outcome {
            XCTAssertEqual(a.id, "hatched-id")
        } else {
            XCTFail("Expected createdNew, got \(outcome)")
        }
    }

    // MARK: - Lockfile id found → returns directly, no active lookup

    func testStoredAssistant_returnsDirectlyWithoutActiveLookup() async throws {
        let idStore = MockActiveAssistantIdStore(storedId: "stored-id")
        let stored = PlatformAssistant(id: "stored-id", name: "Stored")
        let auth = MockBootstrapAuthService(
            organizations: [PlatformOrganization(id: "org-test", name: "Org")],
            getAssistantResult: .found(stored)
        )
        let service = ManagedAssistantBootstrapService(
            authService: auth,
            activeAssistantIdStore: idStore
        )

        let outcome = try await service.ensureManagedAssistant()

        XCTAssertEqual(idStore.clearCallCount, 0)
        XCTAssertEqual(idStore.storedId, "stored-id")
        XCTAssertEqual(auth.getActiveAssistantCallCount, 0, "Found stored assistant must not call active endpoint")
        XCTAssertEqual(auth.hatchCallCount, 0)
        if case .reusedExisting(let a) = outcome {
            XCTAssertEqual(a.id, "stored-id")
        } else {
            XCTFail("Expected reusedExisting, got \(outcome)")
        }
    }

    // MARK: - 403 accessDenied on stored id → still throws accessRevoked

    func testAccessDeniedBranchStillThrows() async throws {
        let idStore = MockActiveAssistantIdStore(storedId: "forbidden-id")
        let auth = MockBootstrapAuthService(
            organizations: [PlatformOrganization(id: "org-test", name: "Org")],
            getAssistantResult: .accessDenied
        )
        let service = ManagedAssistantBootstrapService(
            authService: auth,
            activeAssistantIdStore: idStore
        )

        do {
            _ = try await service.ensureManagedAssistant()
            XCTFail("Expected accessRevoked error")
        } catch ManagedBootstrapError.accessRevoked(let id) {
            XCTAssertEqual(id, "forbidden-id")
        }
        XCTAssertEqual(idStore.clearCallCount, 1)
        XCTAssertNil(idStore.storedId)
        XCTAssertEqual(auth.getActiveAssistantCallCount, 0)
        XCTAssertEqual(auth.hatchCallCount, 0)
    }
}

// MARK: - Mocks

@MainActor
private final class MockActiveAssistantIdStore: ActiveAssistantIdStoring {
    var storedId: String?
    private(set) var clearCallCount = 0

    init(storedId: String? = nil) {
        self.storedId = storedId
    }

    func loadActiveAssistantId() -> String? { storedId }

    func clearActiveAssistantId() {
        storedId = nil
        clearCallCount += 1
    }
}

@MainActor
private final class MockBootstrapAuthService: ManagedAssistantBootstrapAuthServicing {
    let organizations: [PlatformOrganization]
    let getAssistantResult: PlatformAssistantResult
    let getActiveAssistantResult: PlatformAssistantResult

    private(set) var getAssistantCallCount = 0
    private(set) var getActiveAssistantCallCount = 0
    private(set) var hatchCallCount = 0

    init(
        organizations: [PlatformOrganization],
        getAssistantResult: PlatformAssistantResult = .notFound,
        getActiveAssistantResult: PlatformAssistantResult = .notFound
    ) {
        self.organizations = organizations
        self.getAssistantResult = getAssistantResult
        self.getActiveAssistantResult = getActiveAssistantResult
    }

    func getOrganizations() async throws -> [PlatformOrganization] {
        organizations
    }

    func getAssistant(id: String, organizationId: String?) async throws -> PlatformAssistantResult {
        getAssistantCallCount += 1
        return getAssistantResult
    }

    func getActiveAssistant(organizationId: String?) async throws -> PlatformAssistantResult {
        getActiveAssistantCallCount += 1
        return getActiveAssistantResult
    }

    func hatchAssistant(
        organizationId: String?,
        name: String?,
        description: String?,
        anthropicApiKey: String?
    ) async throws -> HatchAssistantResult {
        hatchCallCount += 1
        return .createdNew(PlatformAssistant(id: "hatched-id"))
    }
}
