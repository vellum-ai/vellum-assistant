import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

@MainActor
final class ManagedAssistantConnectionCoordinatorSwitchTests: XCTestCase {
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

        defaultsSuiteName = "ManagedAssistantConnectionCoordinatorSwitchTests.\(UUID().uuidString)"
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

    // MARK: - Flag gating

    func testSwitchThrowsWhenFlagDisabled() async {
        seedLockfile(with: [("managed-a", "2024-01-01T00:00:00Z"),
                            ("managed-b", "2024-02-01T00:00:00Z")])

        let controller = SpyConnectionController()
        let coordinator = makeCoordinator(
            multiEnabled: false,
            controller: controller
        )

        do {
            _ = try await coordinator.switchToManagedAssistant(assistantId: "managed-b")
            XCTFail("Expected multiAssistantNotEnabled")
        } catch ManagedAssistantConnectionCoordinatorError.multiAssistantNotEnabled {
            // expected
        } catch {
            XCTFail("Unexpected error: \(error)")
        }

        XCTAssertEqual(controller.teardownCount, 0)
        XCTAssertEqual(controller.bringUpCount, 0)
        // activeAssistant unchanged
        XCTAssertNil(readActiveAssistant())
    }

    // MARK: - Missing connection controller

    func testSwitchThrowsWhenNoConnectionControllerInjected() async {
        seedLockfile(with: [("managed-a", "2024-01-01T00:00:00Z"),
                            ("managed-b", "2024-02-01T00:00:00Z")])
        LockfileAssistant.setActiveAssistantId("managed-a", lockfilePath: lockfilePath)

        let coordinator = makeCoordinator(
            multiEnabled: true,
            controller: nil
        )

        do {
            _ = try await coordinator.switchToManagedAssistant(assistantId: "managed-b")
            XCTFail("Expected missingConnectionController")
        } catch ManagedAssistantConnectionCoordinatorError.missingConnectionController {
            // expected
        } catch {
            XCTFail("Unexpected error: \(error)")
        }

        // Must not have mutated active assistant id.
        XCTAssertEqual(readActiveAssistant(), "managed-a")
    }

    // MARK: - Missing assistant

    func testSwitchThrowsWhenAssistantNotInLockfile() async {
        seedLockfile(with: [("managed-a", "2024-01-01T00:00:00Z")])

        let controller = SpyConnectionController()
        let coordinator = makeCoordinator(
            multiEnabled: true,
            controller: controller
        )

        do {
            _ = try await coordinator.switchToManagedAssistant(assistantId: "does-not-exist")
            XCTFail("Expected assistantNotFound")
        } catch ManagedAssistantConnectionCoordinatorError.assistantNotFound(let id) {
            XCTAssertEqual(id, "does-not-exist")
        } catch {
            XCTFail("Unexpected error: \(error)")
        }

        XCTAssertEqual(controller.teardownCount, 0)
        XCTAssertEqual(controller.bringUpCount, 0)
    }

    // MARK: - Success path

    func testSwitchTearsDownSetsActiveAndBringsUpExactlyOnce() async throws {
        seedLockfile(with: [("managed-a", "2024-01-01T00:00:00Z"),
                            ("managed-b", "2024-02-01T00:00:00Z")])
        LockfileAssistant.setActiveAssistantId("managed-a", lockfilePath: lockfilePath)

        let controller = SpyConnectionController()
        var taggedId: String?
        let coordinator = makeCoordinator(
            multiEnabled: true,
            controller: controller,
            updateAssistantTag: { taggedId = $0 }
        )

        // Seed a cached flag value so we can verify clearCachedFlags was called.
        AssistantFeatureFlagResolver.writeCachedFlags(["sentinel-flag": true])
        XCTAssertEqual(AssistantFeatureFlagResolver.readCachedFlags()["sentinel-flag"], true)

        let result = try await coordinator.switchToManagedAssistant(assistantId: "managed-b")

        XCTAssertEqual(result.assistant.id, "managed-b")
        XCTAssertEqual(readActiveAssistant(), "managed-b")
        XCTAssertEqual(controller.teardownCount, 1)
        XCTAssertEqual(controller.bringUpCount, 1)
        XCTAssertEqual(controller.broughtUpAssistantId, "managed-b")
        XCTAssertEqual(controller.callOrder, ["teardown", "bringUp"])
        XCTAssertEqual(taggedId, "managed-b")
        XCTAssertNil(
            AssistantFeatureFlagResolver.readCachedFlags()["sentinel-flag"],
            "clearCachedFlags should have been called during switch"
        )
    }

    // MARK: - Regression guard: activate path unchanged when flag off

    func testActivateFlagOffByteForByteUnchanged() async throws {
        let controller = SpyConnectionController()
        let bootstrap = MockBootstrap(
            outcome: .createdNew(PlatformAssistant(id: "managed-activate"))
        )
        let coordinator = ManagedAssistantConnectionCoordinator(
            bootstrapService: bootstrap,
            userDefaults: defaults,
            runtimeURLProvider: { "https://platform.example.com" },
            updateAssistantTag: { _ in },
            lockfilePath: lockfilePath,
            dateProvider: { Date(timeIntervalSince1970: 1_700_000_000) },
            multiAssistantEnabledProvider: { false },
            connectionController: nil // flag-off production: no controller injected
        )

        let result = try await coordinator.activateManagedAssistant()

        XCTAssertEqual(result.assistant.id, "managed-activate")
        XCTAssertEqual(readActiveAssistant(), "managed-activate")
        XCTAssertTrue(defaults.bool(forKey: "collectUsageData"))
        XCTAssertTrue(defaults.bool(forKey: "sendDiagnostics"))
        XCTAssertTrue(defaults.bool(forKey: "tosAccepted"))
        // With no connection controller, bring-up must be a no-op.
        XCTAssertEqual(controller.teardownCount, 0)
        XCTAssertEqual(controller.bringUpCount, 0)
    }

    // MARK: - Helpers

    private func makeCoordinator(
        multiEnabled: Bool,
        controller: ManagedAssistantConnectionController?,
        updateAssistantTag: @escaping (String?) -> Void = { _ in }
    ) -> ManagedAssistantConnectionCoordinator {
        let bootstrap = MockBootstrap(
            outcome: .reusedExisting(PlatformAssistant(id: "unused-bootstrap-id"))
        )
        return ManagedAssistantConnectionCoordinator(
            bootstrapService: bootstrap,
            userDefaults: defaults,
            runtimeURLProvider: { "https://platform.example.com" },
            updateAssistantTag: updateAssistantTag,
            lockfilePath: lockfilePath,
            dateProvider: { Date(timeIntervalSince1970: 1_700_000_000) },
            multiAssistantEnabledProvider: { multiEnabled },
            connectionController: controller
        )
    }

    private func seedLockfile(with entries: [(id: String, hatchedAt: String)]) {
        for entry in entries {
            LockfileAssistant.ensureManagedEntry(
                assistantId: entry.id,
                runtimeUrl: "https://platform.example.com",
                hatchedAt: entry.hatchedAt,
                lockfilePath: lockfilePath
            )
        }
    }

    private func readActiveAssistant() -> String? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: lockfilePath)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return json["activeAssistant"] as? String
    }
}

@MainActor
private final class SpyConnectionController: ManagedAssistantConnectionController {
    private(set) var teardownCount = 0
    private(set) var bringUpCount = 0
    private(set) var broughtUpAssistantId: String?
    private(set) var callOrder: [String] = []

    func teardown() async {
        teardownCount += 1
        callOrder.append("teardown")
    }

    func bringUp(for assistant: LockfileAssistant) async {
        bringUpCount += 1
        broughtUpAssistantId = assistant.assistantId
        callOrder.append("bringUp")
    }
}

@MainActor
private final class MockBootstrap: ManagedAssistantBootstrapProviding {
    private let outcome: ManagedBootstrapOutcome
    init(outcome: ManagedBootstrapOutcome) { self.outcome = outcome }
    func ensureManagedAssistant(
        name: String?,
        description: String?,
        anthropicApiKey: String?
    ) async throws -> ManagedBootstrapOutcome {
        outcome
    }

    func createManagedAssistant(
        name: String?,
        description: String?,
        anthropicApiKey: String?
    ) async throws -> ManagedBootstrapOutcome {
        outcome
    }
}
