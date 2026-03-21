import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

final class LockfileAssistantManagedTests: XCTestCase {
    private var tempDir: URL!
    private var lockfilePath: String!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try! FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        lockfilePath = tempDir.appendingPathComponent(".vellum.lock.json").path
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        super.tearDown()
    }

    // MARK: - ensureManagedEntry: insert when absent

    func testEnsureInsertsWhenLockfileDoesNotExist() {
        let result = LockfileAssistant.ensureManagedEntry(
            assistantId: "test-id",
            runtimeUrl: "https://platform.vellum.ai",
            hatchedAt: "2024-01-01T00:00:00Z",
            lockfilePath: lockfilePath
        )
        XCTAssertTrue(result)

        let data = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let assistants = json["assistants"] as! [[String: Any]]
        XCTAssertEqual(assistants.count, 1)
        XCTAssertEqual(assistants[0]["assistantId"] as? String, "test-id")
        XCTAssertEqual(assistants[0]["cloud"] as? String, "vellum")
        XCTAssertEqual(assistants[0]["runtimeUrl"] as? String, "https://platform.vellum.ai")
        XCTAssertEqual(assistants[0]["hatchedAt"] as? String, "2024-01-01T00:00:00Z")
    }

    func testEnsureInsertsIntoEmptyLockfile() {
        // Pre-create an empty lockfile object.
        let empty: [String: Any] = [:]
        let data = try! JSONSerialization.data(withJSONObject: empty)
        try! data.write(to: URL(fileURLWithPath: lockfilePath))

        let result = LockfileAssistant.ensureManagedEntry(
            assistantId: "new-id",
            runtimeUrl: "https://platform.vellum.ai",
            hatchedAt: "2024-03-01T00:00:00Z",
            lockfilePath: lockfilePath
        )
        XCTAssertTrue(result)

        let readData = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: readData) as! [String: Any]
        let assistants = json["assistants"] as! [[String: Any]]
        XCTAssertEqual(assistants.count, 1)
        XCTAssertEqual(assistants[0]["assistantId"] as? String, "new-id")
    }

    // MARK: - ensureManagedEntry: refresh existing entry

    func testEnsureRefreshesRuntimeUrlWhenEntryAlreadyExists() {
        // Insert first entry.
        LockfileAssistant.ensureManagedEntry(
            assistantId: "test-id",
            runtimeUrl: "https://old.example.com",
            hatchedAt: "2024-01-01T00:00:00Z",
            lockfilePath: lockfilePath
        )

        // Call again with the same assistantId but different values.
        let result = LockfileAssistant.ensureManagedEntry(
            assistantId: "test-id",
            runtimeUrl: "https://new.example.com",
            hatchedAt: "2024-06-01T00:00:00Z",
            lockfilePath: lockfilePath
        )
        XCTAssertTrue(result)

        let data = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let assistants = json["assistants"] as! [[String: Any]]
        XCTAssertEqual(assistants.count, 1, "Should still have exactly 1 entry")
        XCTAssertEqual(assistants[0]["runtimeUrl"] as? String, "https://new.example.com")
        XCTAssertEqual(assistants[0]["hatchedAt"] as? String, "2024-01-01T00:00:00Z")
    }

    // MARK: - ensureManagedEntry: preserves other entries

    func testEnsurePreservesOtherAssistantEntries() {
        // Pre-populate with a local entry.
        let existing: [String: Any] = [
            "assistants": [
                [
                    "assistantId": "local-id",
                    "cloud": "local",
                    "runtimeUrl": "http://localhost:7821",
                    "hatchedAt": "2024-01-01T00:00:00Z",
                ] as [String: Any],
            ]
        ]
        let data = try! JSONSerialization.data(withJSONObject: existing)
        try! data.write(to: URL(fileURLWithPath: lockfilePath))

        // Add a managed entry.
        let result = LockfileAssistant.ensureManagedEntry(
            assistantId: "managed-id",
            runtimeUrl: "https://platform.vellum.ai",
            hatchedAt: "2024-06-01T00:00:00Z",
            lockfilePath: lockfilePath
        )
        XCTAssertTrue(result)

        let readData = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: readData) as! [String: Any]
        let assistants = json["assistants"] as! [[String: Any]]
        XCTAssertEqual(assistants.count, 2)
        XCTAssertTrue(assistants.contains(where: { ($0["assistantId"] as? String) == "local-id" }))
        XCTAssertTrue(assistants.contains(where: { ($0["assistantId"] as? String) == "managed-id" }))
    }

    func testEnsurePreservesNonAssistantLockfileKeys() {
        // Pre-populate with extra top-level keys.
        let existing: [String: Any] = [
            "version": 1,
            "assistants": [] as [[String: Any]],
        ]
        let data = try! JSONSerialization.data(withJSONObject: existing)
        try! data.write(to: URL(fileURLWithPath: lockfilePath))

        LockfileAssistant.ensureManagedEntry(
            assistantId: "test-id",
            runtimeUrl: "https://platform.vellum.ai",
            hatchedAt: "2024-01-01T00:00:00Z",
            lockfilePath: lockfilePath
        )

        let readData = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: readData) as! [String: Any]
        XCTAssertEqual(json["version"] as? Int, 1, "Non-assistant keys should be preserved")
    }

    // MARK: - ensureManagedEntry: always sets cloud to "vellum"

    func testEnsureAlwaysSetsCloudToVellum() {
        LockfileAssistant.ensureManagedEntry(
            assistantId: "test-id",
            runtimeUrl: "https://platform.vellum.ai",
            hatchedAt: "2024-01-01T00:00:00Z",
            lockfilePath: lockfilePath
        )

        let data = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let assistants = json["assistants"] as! [[String: Any]]
        XCTAssertEqual(assistants[0]["cloud"] as? String, "vellum")
    }

    // MARK: - isManaged property

    func testIsManagedReturnsTrueForVellumCloud() {
        let assistant = LockfileAssistant(
            assistantId: "test-id",
            runtimeUrl: "https://platform.vellum.ai",
            bearerToken: nil,
            cloud: "vellum",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: "2024-01-01T00:00:00Z",
            baseDataDir: nil,
            daemonPort: nil,
            gatewayPort: nil,
            instanceDir: nil
        )
        XCTAssertTrue(assistant.isManaged)
    }

    func testIsManagedReturnsTrueForLegacyPlatformCloud() {
        let assistant = LockfileAssistant(
            assistantId: "test-id",
            runtimeUrl: "https://platform.vellum.ai",
            bearerToken: nil,
            cloud: "platform",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: "2024-01-01T00:00:00Z",
            baseDataDir: nil,
            daemonPort: nil,
            gatewayPort: nil,
            instanceDir: nil
        )
        XCTAssertTrue(assistant.isManaged)
    }

    func testIsManagedReturnsFalseForLocalCloud() {
        let assistant = LockfileAssistant(
            assistantId: "test-id",
            runtimeUrl: nil,
            bearerToken: nil,
            cloud: "local",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: nil,
            baseDataDir: nil,
            daemonPort: nil,
            gatewayPort: nil,
            instanceDir: nil
        )
        XCTAssertFalse(assistant.isManaged)
    }

    func testIsManagedReturnsFalseForGcpCloud() {
        let assistant = LockfileAssistant(
            assistantId: "test-id",
            runtimeUrl: nil,
            bearerToken: nil,
            cloud: "gcp",
            project: "my-project",
            region: nil,
            zone: "us-central1-a",
            instanceId: "inst-1",
            hatchedAt: nil,
            baseDataDir: nil,
            daemonPort: nil,
            gatewayPort: nil,
            instanceDir: nil
        )
        XCTAssertFalse(assistant.isManaged)
    }

    func testIsManagedIsCaseInsensitive() {
        let assistant = LockfileAssistant(
            assistantId: "test-id",
            runtimeUrl: "https://platform.vellum.ai",
            bearerToken: nil,
            cloud: "Vellum",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: nil,
            baseDataDir: nil,
            daemonPort: nil,
            gatewayPort: nil,
            instanceDir: nil
        )
        XCTAssertTrue(assistant.isManaged, "isManaged should be case-insensitive")
    }

    // MARK: - isRemote property

    func testIsRemoteReturnsFalseForLocal() {
        let assistant = LockfileAssistant(
            assistantId: "test-id",
            runtimeUrl: nil,
            bearerToken: nil,
            cloud: "local",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: nil,
            baseDataDir: nil,
            daemonPort: nil,
            gatewayPort: nil,
            instanceDir: nil
        )
        XCTAssertFalse(assistant.isRemote)
    }

    func testResolvedDaemonPortPrefersLockfileValueOverEnvironment() {
        let assistant = LockfileAssistant(
            assistantId: "test-id",
            runtimeUrl: nil,
            bearerToken: nil,
            cloud: "local",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: nil,
            baseDataDir: nil,
            daemonPort: 9911,
            gatewayPort: nil,
            instanceDir: nil
        )

        XCTAssertEqual(assistant.resolvedDaemonPort(environment: ["RUNTIME_HTTP_PORT": "7821"]), 9911)
        XCTAssertEqual(assistant.localRuntimeBaseURL, "http://localhost:9911")
    }

    func testResolvedDaemonPortFallsBackToEnvironmentThenDefault() {
        let assistant = LockfileAssistant(
            assistantId: "test-id",
            runtimeUrl: nil,
            bearerToken: nil,
            cloud: "local",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: nil,
            baseDataDir: nil,
            daemonPort: nil,
            gatewayPort: nil,
            instanceDir: nil
        )

        XCTAssertEqual(assistant.resolvedDaemonPort(environment: ["RUNTIME_HTTP_PORT": "8811"]), 8811)
        XCTAssertEqual(assistant.resolvedDaemonPort(environment: [:]), 7821)
    }

    func testResolvedDaemonPortUsesProcessEnvironmentOnlyWhenNoEnvironmentIsInjected() {
        let assistant = LockfileAssistant(
            assistantId: "test-id",
            runtimeUrl: nil,
            bearerToken: nil,
            cloud: "local",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: nil,
            baseDataDir: nil,
            daemonPort: nil,
            gatewayPort: nil,
            instanceDir: nil
        )

        let previous = getenv("RUNTIME_HTTP_PORT").map { String(cString: $0) }
        setenv("RUNTIME_HTTP_PORT", "9912", 1)
        defer {
            if let previous {
                setenv("RUNTIME_HTTP_PORT", previous, 1)
            } else {
                unsetenv("RUNTIME_HTTP_PORT")
            }
        }

        XCTAssertEqual(assistant.resolvedDaemonPort(environment: [:]), 7821)
        XCTAssertEqual(assistant.resolvedDaemonPort(), 9912)
    }

    func testIsRemoteReturnsTrueForVellum() {
        let assistant = LockfileAssistant(
            assistantId: "test-id",
            runtimeUrl: "https://platform.vellum.ai",
            bearerToken: nil,
            cloud: "vellum",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: nil,
            baseDataDir: nil,
            daemonPort: nil,
            gatewayPort: nil,
            instanceDir: nil
        )
        XCTAssertTrue(assistant.isRemote)
    }

    func testIsRemoteReturnsTrueForGcp() {
        let assistant = LockfileAssistant(
            assistantId: "test-id",
            runtimeUrl: nil,
            bearerToken: nil,
            cloud: "gcp",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: nil,
            baseDataDir: nil,
            daemonPort: nil,
            gatewayPort: nil,
            instanceDir: nil
        )
        XCTAssertTrue(assistant.isRemote)
    }

    // MARK: - home property for vellum cloud

    func testHomeReturnsVellumVariantForManagedAssistant() {
        let assistant = LockfileAssistant(
            assistantId: "test-id",
            runtimeUrl: "https://platform.vellum.ai",
            bearerToken: nil,
            cloud: "vellum",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: nil,
            baseDataDir: nil,
            daemonPort: nil,
            gatewayPort: nil,
            instanceDir: nil
        )
        if case .vellum(let runtimeUrl) = assistant.home {
            XCTAssertEqual(runtimeUrl, "https://platform.vellum.ai")
        } else {
            XCTFail("Expected .vellum home for managed assistant, got \(assistant.home)")
        }
    }

    // MARK: - ensureManagedEntry: multiple different assistants

    func testEnsureMultipleDifferentAssistants() {
        LockfileAssistant.ensureManagedEntry(
            assistantId: "assistant-1",
            runtimeUrl: "https://platform.vellum.ai",
            hatchedAt: "2024-01-01T00:00:00Z",
            lockfilePath: lockfilePath
        )
        LockfileAssistant.ensureManagedEntry(
            assistantId: "assistant-2",
            runtimeUrl: "https://platform.vellum.ai",
            hatchedAt: "2024-02-01T00:00:00Z",
            lockfilePath: lockfilePath
        )

        let data = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let assistants = json["assistants"] as! [[String: Any]]
        XCTAssertEqual(assistants.count, 2)
        XCTAssertEqual(assistants[0]["assistantId"] as? String, "assistant-1")
        XCTAssertEqual(assistants[1]["assistantId"] as? String, "assistant-2")
    }
}
