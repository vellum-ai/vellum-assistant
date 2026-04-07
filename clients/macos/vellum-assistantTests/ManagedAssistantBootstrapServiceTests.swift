import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

/// Tests for the multi-assistant bootstrap flag-gated 404 fallback behavior.
///
/// Flag off = today's byte-for-byte behavior (stale ID cleared, fall through to hatch).
/// Flag on = attempt `listAssistants` first; reuse the most-recent existing assistant
/// when the list is non-empty; only fall through to hatch on an empty list (first-run UX).
@MainActor
final class ManagedAssistantBootstrapServiceTests: XCTestCase {
    private var tempDir: URL!
    private var lockfilePath: String!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try! FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        lockfilePath = tempDir.appendingPathComponent(".vellum.lock.json").path
        UserDefaults.standard.set("org-test", forKey: "connectedOrganizationId")
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "connectedOrganizationId")
        try? FileManager.default.removeItem(at: tempDir)
        tempDir = nil
        lockfilePath = nil
        LockfileAssistant.setActiveAssistantId(nil, lockfilePath: nil)
        super.tearDown()
    }

    // MARK: - Regression guard: flag off preserves today's behavior

    func testFlagOff_404_clearsIdAndFallsThroughToHatch() async throws {
        // Seed a stale connected assistant id.
        LockfileAssistant.setActiveAssistantId("stale-id", lockfilePath: lockfilePath)

        let mock = MockBootstrapAuthService(
            organizations: [PlatformOrganization(id: "org-test", name: "Org")],
            getAssistantResult: .notFound
        )
        let service = ManagedAssistantBootstrapService(authService: mock)

        let outcome = try await service.ensureManagedAssistant(
            multiAssistantEnabled: false
        )

        XCTAssertEqual(mock.getAssistantCallCount, 1)
        XCTAssertEqual(mock.listAssistantsCallCount, 0, "Flag off must not call listAssistants")
        XCTAssertEqual(mock.hatchCallCount, 1, "Flag off must fall through to hatch")
        if case .createdNew(let a) = outcome {
            XCTAssertEqual(a.id, "hatched-id")
        } else {
            XCTFail("Expected createdNew from hatch fall-through, got \(outcome)")
        }
    }

    // MARK: - Flag on + 404 + non-empty list: reuse most recent, do not hatch

    func testFlagOn_404_nonEmptyList_returnsMostRecentWithoutHatching() async throws {
        LockfileAssistant.setActiveAssistantId("stale-id", lockfilePath: lockfilePath)

        let older = PlatformAssistant(id: "older", created_at: "2024-01-01T00:00:00Z")
        let newer = PlatformAssistant(id: "newer", created_at: "2025-06-15T12:00:00Z")
        let undated = PlatformAssistant(id: "undated", created_at: nil)

        let mock = MockBootstrapAuthService(
            organizations: [PlatformOrganization(id: "org-test", name: "Org")],
            getAssistantResult: .notFound,
            listAssistantsResult: [older, undated, newer]
        )
        let service = ManagedAssistantBootstrapService(authService: mock)

        let outcome = try await service.ensureManagedAssistant(
            multiAssistantEnabled: true
        )

        XCTAssertEqual(mock.listAssistantsCallCount, 1)
        XCTAssertEqual(mock.hatchCallCount, 0, "Flag on + non-empty list must not hatch")
        if case .reusedExisting(let a) = outcome {
            XCTAssertEqual(a.id, "newer", "Should return the most-recently-created assistant")
        } else {
            XCTFail("Expected reusedExisting, got \(outcome)")
        }
    }

    // MARK: - Flag on + 404 + empty list: hatch (first-run UX)

    func testFlagOn_404_emptyList_fallsThroughToHatch() async throws {
        LockfileAssistant.setActiveAssistantId("stale-id", lockfilePath: lockfilePath)

        let mock = MockBootstrapAuthService(
            organizations: [PlatformOrganization(id: "org-test", name: "Org")],
            getAssistantResult: .notFound,
            listAssistantsResult: []
        )
        let service = ManagedAssistantBootstrapService(authService: mock)

        let outcome = try await service.ensureManagedAssistant(
            multiAssistantEnabled: true
        )

        XCTAssertEqual(mock.listAssistantsCallCount, 1)
        XCTAssertEqual(mock.hatchCallCount, 1, "Empty list must fall through to hatch (first-run UX)")
        if case .createdNew = outcome {
            // expected
        } else {
            XCTFail("Expected createdNew, got \(outcome)")
        }
    }

    // MARK: - Flag on + 200: returns the assistant directly, no list call

    func testFlagOn_foundAssistant_returnsDirectlyWithoutListing() async throws {
        LockfileAssistant.setActiveAssistantId("stored-id", lockfilePath: lockfilePath)

        let stored = PlatformAssistant(id: "stored-id", name: "Stored")
        let mock = MockBootstrapAuthService(
            organizations: [PlatformOrganization(id: "org-test", name: "Org")],
            getAssistantResult: .found(stored)
        )
        let service = ManagedAssistantBootstrapService(authService: mock)

        let outcome = try await service.ensureManagedAssistant(
            multiAssistantEnabled: true
        )

        XCTAssertEqual(mock.listAssistantsCallCount, 0, "Flag on + 200 must not call listAssistants")
        XCTAssertEqual(mock.hatchCallCount, 0)
        if case .reusedExisting(let a) = outcome {
            XCTAssertEqual(a.id, "stored-id")
        } else {
            XCTFail("Expected reusedExisting, got \(outcome)")
        }
    }

    // MARK: - 403 accessDenied branch unchanged regardless of flag

    func testAccessDeniedBranchUnchanged_flagOn() async throws {
        LockfileAssistant.setActiveAssistantId("forbidden-id", lockfilePath: lockfilePath)

        let mock = MockBootstrapAuthService(
            organizations: [PlatformOrganization(id: "org-test", name: "Org")],
            getAssistantResult: .accessDenied
        )
        let service = ManagedAssistantBootstrapService(authService: mock)

        do {
            _ = try await service.ensureManagedAssistant(multiAssistantEnabled: true)
            XCTFail("Expected accessRevoked error")
        } catch ManagedBootstrapError.accessRevoked(let id) {
            XCTAssertEqual(id, "forbidden-id")
        }
        XCTAssertEqual(mock.listAssistantsCallCount, 0)
        XCTAssertEqual(mock.hatchCallCount, 0)
    }
}

// MARK: - Mock

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
