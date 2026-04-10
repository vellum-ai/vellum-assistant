import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

@MainActor
final class ManagedAssistantConnectionCoordinatorTests: XCTestCase {
    private var tempDir: URL!
    private var lockfilePath: String!
    private var defaults: UserDefaults!
    private var defaultsSuiteName: String!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try! FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        lockfilePath = tempDir.appendingPathComponent(".vellum.lock.json").path

        defaultsSuiteName = "ManagedAssistantConnectionCoordinatorTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: defaultsSuiteName)
        defaults.removePersistentDomain(forName: defaultsSuiteName)
    }

    override func tearDown() {
        if let defaultsSuiteName {
            defaults?.removePersistentDomain(forName: defaultsSuiteName)
        }
        defaults = nil
        defaultsSuiteName = nil
        try? FileManager.default.removeItem(at: tempDir)
        tempDir = nil
        lockfilePath = nil
        super.tearDown()
    }

    func testActivateManagedAssistantPersistsSelectionAndDefaults() async throws {
        let assistant = PlatformAssistant(id: "managed-123", name: "Managed")
        let bootstrapService = MockManagedAssistantBootstrapService(
            outcome: .createdNew(assistant)
        )
        var taggedAssistantId: String?

        let coordinator = ManagedAssistantConnectionCoordinator(
            bootstrapService: bootstrapService,
            userDefaults: defaults,
            runtimeURLProvider: { "https://platform.example.com" },
            updateAssistantTag: { taggedAssistantId = $0 },
            lockfilePath: lockfilePath,
            dateProvider: { Date(timeIntervalSince1970: 1_700_000_000) }
        )

        let result = try await coordinator.activateManagedAssistant()

        XCTAssertEqual(result.assistant.id, assistant.id)
        XCTAssertFalse(result.reusedExisting)
        // Verify activeAssistant was written to the lockfile
        let lockfileData = try Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let lockfileJson = try JSONSerialization.jsonObject(with: lockfileData) as? [String: Any]
        XCTAssertEqual(lockfileJson?["activeAssistant"] as? String, assistant.id)
        XCTAssertTrue(defaults.bool(forKey: "collectUsageData"))
        XCTAssertTrue(defaults.bool(forKey: "sendDiagnostics"))
        XCTAssertTrue(defaults.bool(forKey: "tosAccepted"))
        XCTAssertEqual(taggedAssistantId, assistant.id)

        let data = try Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let assistants = json?["assistants"] as? [[String: Any]]
        XCTAssertEqual(assistants?.count, 1)
        XCTAssertEqual(assistants?.first?["assistantId"] as? String, assistant.id)
        XCTAssertEqual(assistants?.first?["runtimeUrl"] as? String, "https://platform.example.com")
        XCTAssertEqual(assistants?.first?["cloud"] as? String, "vellum")
    }

    func testActivateManagedAssistantPreservesExistingPrivacyOptOuts() async throws {
        defaults.set(false, forKey: "collectUsageData")
        defaults.set(false, forKey: "sendDiagnostics")

        let coordinator = ManagedAssistantConnectionCoordinator(
            bootstrapService: MockManagedAssistantBootstrapService(
                outcome: .reusedExisting(PlatformAssistant(id: "managed-456"))
            ),
            userDefaults: defaults,
            runtimeURLProvider: { "https://platform.example.com" },
            updateAssistantTag: { _ in },
            lockfilePath: lockfilePath
        )

        let result = try await coordinator.activateManagedAssistant()

        XCTAssertTrue(result.reusedExisting)
        XCTAssertFalse(defaults.bool(forKey: "collectUsageData"))
        XCTAssertFalse(defaults.bool(forKey: "sendDiagnostics"))
        XCTAssertTrue(defaults.bool(forKey: "tosAccepted"))
    }

    func testActivateManagedAssistantRePopulatesOrgIdAfterCleared() async throws {
        // Simulate performSwitchAssistant clearing the org ID
        defaults.removeObject(forKey: "connectedOrganizationId")
        XCTAssertNil(defaults.string(forKey: "connectedOrganizationId"))

        let defaults = self.defaults!
        let coordinator = ManagedAssistantConnectionCoordinator(
            bootstrapService: MockManagedAssistantBootstrapService(
                outcome: .createdNew(PlatformAssistant(id: "managed-switch")),
                onEnsureManagedAssistant: {
                    // The real ManagedAssistantBootstrapService.ensureManagedAssistant()
                    // calls resolveOrganizationId() which sets connectedOrganizationId.
                    // Simulate that behavior here to verify the coordinator contract.
                    defaults.set("org-resolved-123", forKey: "connectedOrganizationId")
                }
            ),
            userDefaults: defaults,
            runtimeURLProvider: { "https://platform.example.com" },
            updateAssistantTag: { _ in },
            lockfilePath: lockfilePath
        )

        let result = try await coordinator.activateManagedAssistant()

        XCTAssertEqual(result.assistant.id, "managed-switch")
        // Verify the org ID was re-populated by the bootstrap (via resolveOrganizationId)
        XCTAssertEqual(defaults.string(forKey: "connectedOrganizationId"), "org-resolved-123")
        // Verify the assistant ID was persisted by the coordinator
        // Verify activeAssistant was written to the lockfile
        let lockfileData = try Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let lockfileJson = try JSONSerialization.jsonObject(with: lockfileData) as? [String: Any]
        XCTAssertEqual(lockfileJson?["activeAssistant"] as? String, "managed-switch")
    }

    func testActivateManagedAssistantAfterReauthClearsPersistedOrganizationBeforeBootstrap() async throws {
        defaults.set("stale-org", forKey: "connectedOrganizationId")
        var orgIdSeenDuringEnsure: String?
        let defaults = self.defaults!

        let coordinator = ManagedAssistantConnectionCoordinator(
            bootstrapService: MockManagedAssistantBootstrapService(
                outcome: .reusedExisting(PlatformAssistant(id: "managed-reauth")),
                onEnsureManagedAssistant: {
                    orgIdSeenDuringEnsure = defaults.string(forKey: "connectedOrganizationId")
                }
            ),
            userDefaults: defaults,
            runtimeURLProvider: { "https://platform.example.com" },
            updateAssistantTag: { _ in },
            lockfilePath: lockfilePath
        )

        let result = try await coordinator.activateManagedAssistantAfterReauth()

        XCTAssertEqual(result.assistant.id, "managed-reauth")
        XCTAssertNil(orgIdSeenDuringEnsure)
        XCTAssertNil(defaults.string(forKey: "connectedOrganizationId"))
    }

}

@MainActor
private final class MockManagedAssistantBootstrapService: ManagedAssistantBootstrapProviding {
    private let outcome: ManagedBootstrapOutcome?
    private let onEnsureManagedAssistant: (() -> Void)?

    init(
        outcome: ManagedBootstrapOutcome? = nil,
        onEnsureManagedAssistant: (() -> Void)? = nil
    ) {
        self.outcome = outcome
        self.onEnsureManagedAssistant = onEnsureManagedAssistant
    }

    func ensureManagedAssistant(
        name: String?,
        description: String?,
        anthropicApiKey: String?,
        multiAssistantEnabled: Bool
    ) async throws -> ManagedBootstrapOutcome {
        onEnsureManagedAssistant?()
        guard let outcome else {
            fatalError("ensureManagedAssistant called without a configured outcome")
        }
        return outcome
    }
}
