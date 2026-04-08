import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

/// Tests for the multi-assistant bootstrap flag-gated 404 fallback behavior.
///
/// Flag off = today's byte-for-byte behavior (stale ID cleared, fall through to hatch).
/// Flag on = attempt `listAssistants` first; reuse the most-recent existing assistant
/// when the list is non-empty; only fall through to hatch on an empty list (first-run UX).
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

    // MARK: - Regression guard: flag off preserves today's behavior

    func testFlagOff_404_clearsIdAndFallsThroughToHatch() async throws {
        let idStore = MockActiveAssistantIdStore(storedId: "stale-id")
        let auth = MockBootstrapAuthService(
            organizations: [PlatformOrganization(id: "org-test", name: "Org")],
            getAssistantResult: .notFound
        )
        let service = ManagedAssistantBootstrapService(
            authService: auth,
            activeAssistantIdStore: idStore
        )

        let outcome = try await service.ensureManagedAssistant(multiAssistantEnabled: false)

        XCTAssertEqual(auth.getAssistantCallCount, 1)
        XCTAssertEqual(idStore.clearCallCount, 1, "Stale ID must be cleared on 404")
        XCTAssertNil(idStore.storedId, "Store must reflect the cleared id")
        XCTAssertEqual(auth.listAssistantsCallCount, 0, "Flag off must not call listAssistants")
        XCTAssertEqual(auth.hatchCallCount, 1, "Flag off must fall through to hatch")
        if case .createdNew(let a) = outcome {
            XCTAssertEqual(a.id, "hatched-id")
        } else {
            XCTFail("Expected createdNew from hatch fall-through, got \(outcome)")
        }
    }

    // MARK: - Flag on + 404 + non-empty list: reuse first from list, do not hatch

    func testFlagOn_404_nonEmptyList_returnsFirstWithoutHatching() async throws {
        // The bootstrap trusts the platform to return newest-first, so it
        // just takes `results.first`. Non-empty list → reuse, no hatch.
        let idStore = MockActiveAssistantIdStore(storedId: "stale-id")
        let first = PlatformAssistant(id: "newest", name: "Newest")
        let second = PlatformAssistant(id: "older", name: "Older")

        let auth = MockBootstrapAuthService(
            organizations: [PlatformOrganization(id: "org-test", name: "Org")],
            getAssistantResult: .notFound,
            listAssistantsResult: [first, second]
        )
        let service = ManagedAssistantBootstrapService(
            authService: auth,
            activeAssistantIdStore: idStore
        )

        let outcome = try await service.ensureManagedAssistant(multiAssistantEnabled: true)

        XCTAssertEqual(idStore.clearCallCount, 1)
        XCTAssertNil(idStore.storedId)
        XCTAssertEqual(auth.listAssistantsCallCount, 1)
        XCTAssertEqual(auth.hatchCallCount, 0, "Flag on + non-empty list must not hatch")
        if case .reusedExisting(let a) = outcome {
            XCTAssertEqual(a.id, "newest", "Should return the first assistant from the list")
        } else {
            XCTFail("Expected reusedExisting, got \(outcome)")
        }
    }

    // MARK: - Flag on + 404 + empty list: hatch (first-run UX)

    func testFlagOn_404_emptyList_fallsThroughToHatch() async throws {
        let idStore = MockActiveAssistantIdStore(storedId: "stale-id")
        let auth = MockBootstrapAuthService(
            organizations: [PlatformOrganization(id: "org-test", name: "Org")],
            getAssistantResult: .notFound,
            listAssistantsResult: []
        )
        let service = ManagedAssistantBootstrapService(
            authService: auth,
            activeAssistantIdStore: idStore
        )

        let outcome = try await service.ensureManagedAssistant(multiAssistantEnabled: true)

        XCTAssertEqual(idStore.clearCallCount, 1)
        XCTAssertEqual(auth.listAssistantsCallCount, 1)
        XCTAssertEqual(auth.hatchCallCount, 1, "Empty list must fall through to hatch (first-run UX)")
        if case .createdNew = outcome {
            // expected
        } else {
            XCTFail("Expected createdNew, got \(outcome)")
        }
    }

    // MARK: - Flag on + 200: returns the assistant directly, no list call

    func testFlagOn_foundAssistant_returnsDirectlyWithoutListing() async throws {
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

        let outcome = try await service.ensureManagedAssistant(multiAssistantEnabled: true)

        XCTAssertEqual(idStore.clearCallCount, 0, "Found assistant must not clear the id")
        XCTAssertEqual(idStore.storedId, "stored-id", "Store must be untouched on found")
        XCTAssertEqual(auth.listAssistantsCallCount, 0, "Flag on + 200 must not call listAssistants")
        XCTAssertEqual(auth.hatchCallCount, 0)
        if case .reusedExisting(let a) = outcome {
            XCTAssertEqual(a.id, "stored-id")
        } else {
            XCTFail("Expected reusedExisting, got \(outcome)")
        }
    }

    // MARK: - 403 accessDenied branch unchanged regardless of flag

    func testAccessDeniedBranchUnchanged_flagOn() async throws {
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
            _ = try await service.ensureManagedAssistant(multiAssistantEnabled: true)
            XCTFail("Expected accessRevoked error")
        } catch ManagedBootstrapError.accessRevoked(let id) {
            XCTAssertEqual(id, "forbidden-id")
        }
        XCTAssertEqual(idStore.clearCallCount, 1, "accessDenied must clear the id")
        XCTAssertNil(idStore.storedId)
        XCTAssertEqual(auth.listAssistantsCallCount, 0)
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
    let listAssistantsResult: [PlatformAssistant]

    private(set) var getAssistantCallCount = 0
    private(set) var listAssistantsCallCount = 0
    private(set) var hatchCallCount = 0

    init(
        organizations: [PlatformOrganization],
        getAssistantResult: PlatformAssistantResult = .notFound,
        listAssistantsResult: [PlatformAssistant] = []
    ) {
        self.organizations = organizations
        self.getAssistantResult = getAssistantResult
        self.listAssistantsResult = listAssistantsResult
    }

    func getOrganizations() async throws -> [PlatformOrganization] {
        organizations
    }

    func getAssistant(id: String, organizationId: String) async throws -> PlatformAssistantResult {
        getAssistantCallCount += 1
        return getAssistantResult
    }

    func listAssistants(organizationId: String) async throws -> [PlatformAssistant] {
        listAssistantsCallCount += 1
        return listAssistantsResult
    }

    func hatchAssistant(
        organizationId: String,
        name: String?,
        description: String?,
        anthropicApiKey: String?
    ) async throws -> HatchAssistantResult {
        hatchCallCount += 1
        return .createdNew(PlatformAssistant(id: "hatched-id"))
    }
}
