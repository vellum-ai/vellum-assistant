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
        XCTAssertEqual(defaults.string(forKey: "connectedAssistantId"), assistant.id)
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

    func testActivateAssociatedManagedAssistantIfPresentPersistsManagedSelection() async throws {
        let assistant = PlatformAssistant(id: "managed-existing", name: "Existing")
        let coordinator = ManagedAssistantConnectionCoordinator(
            bootstrapService: MockManagedAssistantBootstrapService(
                discoveredAssistant: assistant
            ),
            userDefaults: defaults,
            runtimeURLProvider: { "https://platform.example.com" },
            updateAssistantTag: { _ in },
            lockfilePath: lockfilePath
        )

        let result = try await coordinator.activateAssociatedManagedAssistantIfPresent()

        XCTAssertEqual(result?.assistant.id, assistant.id)
        XCTAssertEqual(result?.reusedExisting, true)
        XCTAssertEqual(defaults.string(forKey: "connectedAssistantId"), assistant.id)

        let data = try Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let assistants = json?["assistants"] as? [[String: Any]]
        XCTAssertEqual(assistants?.count, 1)
        XCTAssertEqual(assistants?.first?["assistantId"] as? String, assistant.id)
        XCTAssertEqual(assistants?.first?["cloud"] as? String, "vellum")
    }

    func testActivateAssociatedManagedAssistantIfPresentReturnsNilWhenAccountHasNoManagedAssistant() async throws {
        let coordinator = ManagedAssistantConnectionCoordinator(
            bootstrapService: MockManagedAssistantBootstrapService(
                discoveredAssistant: nil
            ),
            userDefaults: defaults,
            runtimeURLProvider: { "https://platform.example.com" },
            updateAssistantTag: { _ in },
            lockfilePath: lockfilePath
        )

        let result = try await coordinator.activateAssociatedManagedAssistantIfPresent()

        XCTAssertNil(result)
        XCTAssertNil(defaults.string(forKey: "connectedAssistantId"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: lockfilePath))
    }
}

@MainActor
private final class MockManagedAssistantBootstrapService: ManagedAssistantBootstrapProviding {
    private let outcome: ManagedBootstrapOutcome?
    private let discoveredAssistant: PlatformAssistant?

    init(
        outcome: ManagedBootstrapOutcome? = nil,
        discoveredAssistant: PlatformAssistant? = nil
    ) {
        self.outcome = outcome
        self.discoveredAssistant = discoveredAssistant
    }

    func ensureManagedAssistant(
        name: String?,
        description: String?,
        anthropicApiKey: String?
    ) async throws -> ManagedBootstrapOutcome {
        guard let outcome else {
            fatalError("ensureManagedAssistant called without a configured outcome")
        }
        return outcome
    }

    func discoverManagedAssistant() async throws -> PlatformAssistant? {
        discoveredAssistant
    }
}
