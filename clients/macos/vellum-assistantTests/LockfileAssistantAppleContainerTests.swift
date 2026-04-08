import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

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
            lockfilePath: lockfilePath
        )
        XCTAssertTrue(result)

        let data = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let assistants = json["assistants"] as! [[String: Any]]
        XCTAssertEqual(assistants.count, 1)
        XCTAssertEqual(assistants[0]["assistantId"] as? String, "ac-test")
        XCTAssertEqual(assistants[0]["cloud"] as? String, "apple-container")
        XCTAssertEqual(assistants[0]["hatchedAt"] as? String, "2025-06-01T00:00:00Z")
    }

    func testInsertsIntoEmptyLockfile() {
        let empty: [String: Any] = [:]
        let data = try! JSONSerialization.data(withJSONObject: empty)
        try! data.write(to: URL(fileURLWithPath: lockfilePath))

        let result = AppleContainersLauncher.writeLockfileEntry(
            assistantId: "ac-new",
            hatchedAt: "2025-07-01T00:00:00Z",
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

    func testUpdatesCloudOnExistingEntry() {
        // Pre-populate with a local entry that has the same ID.
        let existing: [String: Any] = [
            "assistants": [
                [
                    "assistantId": "ac-test",
                    "cloud": "local",
                    "hatchedAt": "2025-01-01T00:00:00Z",
                ] as [String: Any],
            ]
        ]
        let data = try! JSONSerialization.data(withJSONObject: existing)
        try! data.write(to: URL(fileURLWithPath: lockfilePath))

        let result = AppleContainersLauncher.writeLockfileEntry(
            assistantId: "ac-test",
            hatchedAt: "2025-06-01T00:00:00Z",
            lockfilePath: lockfilePath
        )
        XCTAssertTrue(result)

        let readData = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: readData) as! [String: Any]
        let assistants = json["assistants"] as! [[String: Any]]
        XCTAssertEqual(assistants.count, 1)
        XCTAssertEqual(assistants[0]["cloud"] as? String, "apple-container")
        // Original hatchedAt should be preserved.
        XCTAssertEqual(assistants[0]["hatchedAt"] as? String, "2025-01-01T00:00:00Z")
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
            lockfilePath: lockfilePath
        )

        let readData = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: readData) as! [String: Any]
        let assistants = json["assistants"] as! [[String: Any]]
        XCTAssertEqual(assistants.count, 2)
        XCTAssertTrue(assistants.contains(where: { ($0["assistantId"] as? String) == "local-id" }))
        XCTAssertTrue(assistants.contains(where: { ($0["assistantId"] as? String) == "ac-id" }))
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
            lockfilePath: lockfilePath
        )

        let readData = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: readData) as! [String: Any]
        XCTAssertEqual(json["version"] as? Int, 1)
    }

    // MARK: - writeLockfileEntry: no-op when unchanged

    func testNoOpWhenEntryAlreadyCorrect() {
        AppleContainersLauncher.writeLockfileEntry(
            assistantId: "ac-test",
            hatchedAt: "2025-06-01T00:00:00Z",
            lockfilePath: lockfilePath
        )

        // Get file modification time.
        let attrs1 = try! FileManager.default.attributesOfItem(atPath: lockfilePath)
        let date1 = attrs1[.modificationDate] as! Date

        // Small sleep to ensure a different modification time if the file were rewritten.
        Thread.sleep(forTimeInterval: 0.05)

        let result = AppleContainersLauncher.writeLockfileEntry(
            assistantId: "ac-test",
            hatchedAt: "2025-07-01T00:00:00Z",
            lockfilePath: lockfilePath
        )
        XCTAssertTrue(result)

        let attrs2 = try! FileManager.default.attributesOfItem(atPath: lockfilePath)
        let date2 = attrs2[.modificationDate] as! Date
        XCTAssertEqual(date1, date2, "File should not be rewritten when entry is unchanged")
    }

    // MARK: - isAppleContainer property

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
