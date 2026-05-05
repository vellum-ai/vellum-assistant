import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

/// Tests for the managed-assistant bootstrap flow.
///
/// On macOS the bootstrap always lists platform assistants before falling
/// through to hatch. When a stored assistant ID exists and the GET returns
/// 200, the assistant is returned directly (no list call). When the GET
/// returns 404 (stale ID), or when no stored ID exists at all, the service
/// lists platform assistants and reuses the first result. The backend
/// already scopes the list to platform assistants, so no filter parameter
/// is needed. Only when the list is empty does it fall through to hatch
/// (first-run UX).
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

    // MARK: - Stored ID found (200): return directly, no list or hatch

    /// Verifies that a valid stored assistant ID bypasses both listing and hatching.
    func testStoredId_found_returnsDirectlyWithoutListingOrHatching() async throws {
        // GIVEN a stored assistant ID that resolves to a valid assistant
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

        // WHEN we bootstrap the managed assistant
        let outcome = try await service.ensureManagedAssistant()

        // THEN the stored assistant is returned directly
        XCTAssertEqual(idStore.clearCallCount, 0, "Found assistant must not clear the id")
        XCTAssertEqual(idStore.storedId, "stored-id", "Store must be untouched on found")

        // AND listing and hatching are not called
        XCTAssertEqual(auth.listAssistantsCallCount, 0, "200 must not call listAssistants")
        XCTAssertEqual(auth.hatchCallCount, 0)
        if case .reusedExisting(let a) = outcome {
            XCTAssertEqual(a.id, "stored-id")
        } else {
            XCTFail("Expected reusedExisting, got \(outcome)")
        }
    }

    // MARK: - Stored ID 404: clear stale ID, list platform assistants, reuse first

    /// Verifies that a stale 404'd stored ID is cleared and the service lists
    /// platform assistants, reusing the first one when the list is non-empty.
    func test404_nonEmptyList_clearsIdAndReusesFirstFromList() async throws {
        // GIVEN a stale stored ID that returns 404
        let idStore = MockActiveAssistantIdStore(storedId: "stale-id")
        let first = PlatformAssistant(id: "newest", name: "Newest")
        let second = PlatformAssistant(id: "older", name: "Older")

        // AND the list endpoint returns two platform assistants
        let auth = MockBootstrapAuthService(
            organizations: [PlatformOrganization(id: "org-test", name: "Org")],
            getAssistantResult: .notFound,
            listAssistantsResult: [first, second]
        )
        let service = ManagedAssistantBootstrapService(
            authService: auth,
            activeAssistantIdStore: idStore
        )

        // WHEN we bootstrap the managed assistant
        let outcome = try await service.ensureManagedAssistant()

        // THEN the stale ID is cleared
        XCTAssertEqual(idStore.clearCallCount, 1)
        XCTAssertNil(idStore.storedId)

        // AND listAssistants is called
        XCTAssertEqual(auth.listAssistantsCallCount, 1)

        // AND the first assistant from the list is reused without hatching
        XCTAssertEqual(auth.hatchCallCount, 0, "Non-empty list must not hatch")
        if case .reusedExisting(let a) = outcome {
            XCTAssertEqual(a.id, "newest", "Should return the first assistant from the list")
        } else {
            XCTFail("Expected reusedExisting, got \(outcome)")
        }
    }

    // MARK: - Stored ID 404 + empty list: fall through to hatch

    /// Verifies that when the stored ID 404s and the platform list is empty,
    /// the service falls through to hatch (first-run UX).
    func test404_emptyList_fallsThroughToHatch() async throws {
        // GIVEN a stale stored ID that returns 404
        let idStore = MockActiveAssistantIdStore(storedId: "stale-id")

        // AND the list endpoint returns an empty list
        let auth = MockBootstrapAuthService(
            organizations: [PlatformOrganization(id: "org-test", name: "Org")],
            getAssistantResult: .notFound,
            listAssistantsResult: []
        )
        let service = ManagedAssistantBootstrapService(
            authService: auth,
            activeAssistantIdStore: idStore
        )

        // WHEN we bootstrap the managed assistant
        let outcome = try await service.ensureManagedAssistant()

        // THEN the stale ID is cleared
        XCTAssertEqual(idStore.clearCallCount, 1)

        // AND listAssistants is called
        XCTAssertEqual(auth.listAssistantsCallCount, 1)

        // AND hatch is called as the first-run fallback
        XCTAssertEqual(auth.hatchCallCount, 1, "Empty list must fall through to hatch (first-run UX)")
        if case .createdNew = outcome {
            // expected
        } else {
            XCTFail("Expected createdNew, got \(outcome)")
        }
    }

    // MARK: - No stored ID + non-empty list: reuse first platform assistant

    /// Verifies that when there is no stored assistant ID, the service lists
    /// platform assistants and reuses the first one.
    func testNoStoredId_nonEmptyList_reusesFirstFromList() async throws {
        // GIVEN no stored assistant ID
        let idStore = MockActiveAssistantIdStore(storedId: nil)
        let existing = PlatformAssistant(id: "platform-1", name: "Platform One")

        // AND the list endpoint returns a platform assistant
        let auth = MockBootstrapAuthService(
            organizations: [PlatformOrganization(id: "org-test", name: "Org")],
            listAssistantsResult: [existing]
        )
        let service = ManagedAssistantBootstrapService(
            authService: auth,
            activeAssistantIdStore: idStore
        )

        // WHEN we bootstrap the managed assistant
        let outcome = try await service.ensureManagedAssistant()

        // THEN getAssistant is never called (no stored ID to look up)
        XCTAssertEqual(auth.getAssistantCallCount, 0)

        // AND listAssistants is called
        XCTAssertEqual(auth.listAssistantsCallCount, 1)

        // AND the first assistant is reused without hatching
        XCTAssertEqual(auth.hatchCallCount, 0, "Non-empty list must not hatch")
        if case .reusedExisting(let a) = outcome {
            XCTAssertEqual(a.id, "platform-1")
        } else {
            XCTFail("Expected reusedExisting, got \(outcome)")
        }
    }

    // MARK: - No stored ID + empty list: fall through to hatch

    /// Verifies that when there is no stored assistant ID and the platform
    /// list is empty, the service falls through to hatch.
    func testNoStoredId_emptyList_fallsThroughToHatch() async throws {
        // GIVEN no stored assistant ID
        let idStore = MockActiveAssistantIdStore(storedId: nil)

        // AND the list endpoint returns an empty list
        let auth = MockBootstrapAuthService(
            organizations: [PlatformOrganization(id: "org-test", name: "Org")],
            listAssistantsResult: []
        )
        let service = ManagedAssistantBootstrapService(
            authService: auth,
            activeAssistantIdStore: idStore
        )

        // WHEN we bootstrap the managed assistant
        let outcome = try await service.ensureManagedAssistant()

        // THEN getAssistant is never called (no stored ID to look up)
        XCTAssertEqual(auth.getAssistantCallCount, 0)

        // AND listAssistants is called
        XCTAssertEqual(auth.listAssistantsCallCount, 1)

        // AND hatch is called as the first-run fallback
        XCTAssertEqual(auth.hatchCallCount, 1)
        XCTAssertEqual(auth.hatchModes, [.ensure])
        if case .createdNew = outcome {
            // expected
        } else {
            XCTFail("Expected createdNew, got \(outcome)")
        }
    }

    func testCreateManagedAssistantSkipsReuseLookupsAndUsesCreateMode() async throws {
        let idStore = MockActiveAssistantIdStore(storedId: "current-managed")
        let auth = MockBootstrapAuthService(
            organizations: [PlatformOrganization(id: "org-test", name: "Org")],
            listAssistantsResult: [PlatformAssistant(id: "existing-managed", name: "Existing")]
        )
        let service = ManagedAssistantBootstrapService(
            authService: auth,
            activeAssistantIdStore: idStore
        )

        let outcome = try await service.createManagedAssistant(name: "Nova")

        XCTAssertEqual(idStore.clearCallCount, 0)
        XCTAssertEqual(auth.getAssistantCallCount, 0)
        XCTAssertEqual(auth.listAssistantsCallCount, 0)
        XCTAssertEqual(auth.hatchCallCount, 1)
        XCTAssertEqual(auth.hatchModes, [.create])
        if case .createdNew(let assistant) = outcome {
            XCTAssertEqual(assistant.id, "hatched-id")
        } else {
            XCTFail("Expected createdNew, got \(outcome)")
        }
    }

    // MARK: - 403 accessDenied: throws without listing or hatching

    /// Verifies that a 403 on the stored ID throws accessRevoked and does
    /// not attempt to list or hatch.
    func testAccessDenied_throwsWithoutListingOrHatching() async throws {
        // GIVEN a stored assistant ID that returns 403
        let idStore = MockActiveAssistantIdStore(storedId: "forbidden-id")
        let auth = MockBootstrapAuthService(
            organizations: [PlatformOrganization(id: "org-test", name: "Org")],
            getAssistantResult: .accessDenied
        )
        let service = ManagedAssistantBootstrapService(
            authService: auth,
            activeAssistantIdStore: idStore
        )

        // WHEN we bootstrap the managed assistant
        // THEN an accessRevoked error is thrown
        do {
            _ = try await service.ensureManagedAssistant()
            XCTFail("Expected accessRevoked error")
        } catch ManagedBootstrapError.accessRevoked(let id) {
            XCTAssertEqual(id, "forbidden-id")
        }

        // AND the stale ID is cleared
        XCTAssertEqual(idStore.clearCallCount, 1, "accessDenied must clear the id")
        XCTAssertNil(idStore.storedId)

        // AND listing and hatching are not called
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
    private(set) var hatchModes: [HatchAssistantMode] = []

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

    // Mirrors `AuthService.resolveOrganizationId` so the bootstrap's
    // error-translation layer gets exercised.
    func resolveOrganizationId() async throws -> String {
        let persisted = UserDefaults.standard.string(forKey: "connectedOrganizationId")
        if let persisted, organizations.contains(where: { $0.id == persisted }) {
            return persisted
        }
        switch organizations.count {
        case 0:
            throw AuthService.OrganizationResolutionError.noOrganizations
        case 1:
            let orgId = organizations[0].id
            UserDefaults.standard.set(orgId, forKey: "connectedOrganizationId")
            return orgId
        default:
            throw AuthService.OrganizationResolutionError.multipleOrganizations
        }
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
        anthropicApiKey: String?,
        mode: HatchAssistantMode
    ) async throws -> HatchAssistantResult {
        hatchCallCount += 1
        hatchModes.append(mode)
        return .createdNew(PlatformAssistant(id: "hatched-id"))
    }
}
