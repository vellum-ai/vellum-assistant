import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

// MARK: - AppleContainersLauncher.writeLockfileEntry Tests

@available(macOS 26.0, *)
final class LockfileAssistantAppleContainerTests: XCTestCase {
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

    // MARK: - writeLockfileEntry: insert when absent

    func testInsertsWhenLockfileDoesNotExist() {
        let result = AppleContainersLauncher.writeLockfileEntry(
            assistantId: "ac-test",
            hatchedAt: "2025-06-01T00:00:00Z",
            signingKey: "key1",
            lockfilePath: lockfilePath
        )
        XCTAssertTrue(result)

        let data = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let assistants = json["assistants"] as! [[String: Any]]
        XCTAssertEqual(assistants.count, 1)
        XCTAssertEqual(assistants[0]["assistantId"] as? String, "ac-test")
        XCTAssertEqual(assistants[0]["cloud"] as? String, "apple-container")
        XCTAssertEqual(assistants[0]["runtimeBackend"] as? String, "apple-containers")
        XCTAssertEqual(assistants[0]["hatchedAt"] as? String, "2025-06-01T00:00:00Z")
        let resources = assistants[0]["resources"] as? [String: Any]
        XCTAssertEqual(resources?["signingKey"] as? String, "key1")
    }

    func testInsertsIntoEmptyLockfile() {
        let empty: [String: Any] = [:]
        let data = try! JSONSerialization.data(withJSONObject: empty)
        try! data.write(to: URL(fileURLWithPath: lockfilePath))

        let result = AppleContainersLauncher.writeLockfileEntry(
            assistantId: "ac-new",
            hatchedAt: "2025-07-01T00:00:00Z",
            signingKey: "key2",
            lockfilePath: lockfilePath
        )
        XCTAssertTrue(result)

        let readData = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: readData) as! [String: Any]
        let assistants = json["assistants"] as! [[String: Any]]
        XCTAssertEqual(assistants.count, 1)
        XCTAssertEqual(assistants[0]["assistantId"] as? String, "ac-new")
    }

    // MARK: - writeLockfileEntry: update existing entry

    func testUpdatesExistingEntry() {
        AppleContainersLauncher.writeLockfileEntry(
            assistantId: "ac-test",
            hatchedAt: "2025-01-01T00:00:00Z",
            signingKey: "old-key",
            lockfilePath: lockfilePath
        )

        AppleContainersLauncher.writeLockfileEntry(
            assistantId: "ac-test",
            hatchedAt: "2025-06-01T00:00:00Z",
            signingKey: "new-key",
            lockfilePath: lockfilePath
        )

        let readData = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: readData) as! [String: Any]
        let assistants = json["assistants"] as! [[String: Any]]
        XCTAssertEqual(assistants.count, 1)
        XCTAssertEqual(assistants[0]["cloud"] as? String, "apple-container")
        XCTAssertEqual(assistants[0]["hatchedAt"] as? String, "2025-06-01T00:00:00Z")
        let resources = assistants[0]["resources"] as? [String: Any]
        XCTAssertEqual(resources?["signingKey"] as? String, "new-key")
    }

    // MARK: - writeLockfileEntry: preserves other entries

    func testPreservesOtherAssistantEntries() {
        let existing: [String: Any] = [
            "assistants": [
                [
                    "assistantId": "local-id",
                    "cloud": "local",
                    "hatchedAt": "2024-01-01T00:00:00Z",
                ] as [String: Any],
            ]
        ]
        let data = try! JSONSerialization.data(withJSONObject: existing)
        try! data.write(to: URL(fileURLWithPath: lockfilePath))

        AppleContainersLauncher.writeLockfileEntry(
            assistantId: "ac-id",
            hatchedAt: "2025-06-01T00:00:00Z",
            signingKey: "key3",
            lockfilePath: lockfilePath
        )

        let readData = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: readData) as! [String: Any]
        let assistants = json["assistants"] as! [[String: Any]]
        XCTAssertEqual(assistants.count, 2)
        XCTAssertTrue(assistants.contains(where: { ($0["assistantId"] as? String) == "local-id" }))
        XCTAssertTrue(assistants.contains(where: { ($0["assistantId"] as? String) == "ac-id" }))
    }

    func testWritesMgmtSocketWhenProvided() {
        let result = AppleContainersLauncher.writeLockfileEntry(
            assistantId: "ac-mgmt",
            hatchedAt: "2025-08-01T00:00:00Z",
            signingKey: "key5",
            mgmtSocket: "/Users/test/Library/Application Support/vellum-assistant-dev/cli.sock",
            lockfilePath: lockfilePath
        )
        XCTAssertTrue(result)

        let data = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let assistants = json["assistants"] as! [[String: Any]]
        XCTAssertEqual(assistants.count, 1)
        XCTAssertEqual(
            assistants[0]["mgmtSocket"] as? String,
            "/Users/test/Library/Application Support/vellum-assistant-dev/cli.sock"
        )
    }

    func testMgmtSocketRoundTripsViaLockfileParser() {
        let socketPath = "/Users/test/Library/Application Support/vellum-assistant-dev/cli.sock"
        AppleContainersLauncher.writeLockfileEntry(
            assistantId: "ac-rt",
            hatchedAt: "2025-08-01T00:00:00Z",
            signingKey: "key9",
            mgmtSocket: socketPath,
            lockfilePath: lockfilePath
        )

        let loaded = LockfileAssistant.loadByName("ac-rt", lockfilePath: lockfilePath)
        XCTAssertNotNil(loaded)
        XCTAssertEqual(loaded?.mgmtSocket, socketPath)
        XCTAssertEqual(loaded?.cloud, "apple-container")
    }

    func testOmitsMgmtSocketWhenNil() {
        let result = AppleContainersLauncher.writeLockfileEntry(
            assistantId: "ac-no-mgmt",
            hatchedAt: "2025-08-01T00:00:00Z",
            signingKey: "key6",
            lockfilePath: lockfilePath
        )
        XCTAssertTrue(result)

        let data = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let assistants = json["assistants"] as! [[String: Any]]
        XCTAssertEqual(assistants.count, 1)
        XCTAssertNil(assistants[0]["mgmtSocket"])
    }

    func testPreservesNonAssistantLockfileKeys() {
        let existing: [String: Any] = [
            "version": 1,
            "assistants": [] as [[String: Any]],
        ]
        let data = try! JSONSerialization.data(withJSONObject: existing)
        try! data.write(to: URL(fileURLWithPath: lockfilePath))

        AppleContainersLauncher.writeLockfileEntry(
            assistantId: "ac-test",
            hatchedAt: "2025-06-01T00:00:00Z",
            signingKey: "key4",
            lockfilePath: lockfilePath
        )

        let readData = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: readData) as! [String: Any]
        XCTAssertEqual(json["version"] as? Int, 1)
    }

}

// MARK: - LockfileAssistant.isAppleContainer Tests

final class LockfileAssistantIsAppleContainerTests: XCTestCase {

    func testIsAppleContainerReturnsTrueForAppleContainerCloud() {
        let assistant = LockfileAssistant(
            assistantId: "ac-test",
            runtimeUrl: nil,
            bearerToken: nil,
            cloud: "apple-container",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: "2025-06-01T00:00:00Z",
            baseDataDir: nil,
            gatewayPort: nil,
            instanceDir: nil
        )
        XCTAssertTrue(assistant.isAppleContainer)
    }

    func testIsAppleContainerReturnsFalseForLocalCloud() {
        let assistant = LockfileAssistant(
            assistantId: "local-test",
            runtimeUrl: nil,
            bearerToken: nil,
            cloud: "local",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: nil,
            baseDataDir: nil,
            gatewayPort: nil,
            instanceDir: nil
        )
        XCTAssertFalse(assistant.isAppleContainer)
    }
}
