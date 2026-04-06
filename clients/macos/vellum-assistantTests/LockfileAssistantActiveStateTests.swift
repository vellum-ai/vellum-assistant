import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

final class LockfileAssistantActiveStateTests: XCTestCase {
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
        LockfileAssistant.stopWatching()
        try? FileManager.default.removeItem(at: tempDir)
        super.tearDown()
    }

    // MARK: - setActiveAssistantId: basic writes

    func testSetActiveAssistantIdCreatesLockfileWhenAbsent() {
        let result = LockfileAssistant.setActiveAssistantId("assistant-1", lockfilePath: lockfilePath)
        XCTAssertTrue(result)

        let data = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["activeAssistant"] as? String, "assistant-1")
    }

    func testSetActiveAssistantIdUpdatesExistingLockfile() {
        // Pre-create a lockfile with some content.
        let existing: [String: Any] = [
            "version": 1,
            "assistants": [["assistantId": "a1", "cloud": "local"] as [String: Any]],
            "activeAssistant": "old-id",
        ]
        let data = try! JSONSerialization.data(withJSONObject: existing)
        try! data.write(to: URL(fileURLWithPath: lockfilePath))

        let result = LockfileAssistant.setActiveAssistantId("new-id", lockfilePath: lockfilePath)
        XCTAssertTrue(result)

        let readData = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: readData) as! [String: Any]
        XCTAssertEqual(json["activeAssistant"] as? String, "new-id")
        // Existing keys should be preserved.
        XCTAssertEqual(json["version"] as? Int, 1)
        XCTAssertNotNil(json["assistants"])
    }

    func testSetActiveAssistantIdClearsFieldWhenNil() {
        // Write an initial value.
        LockfileAssistant.setActiveAssistantId("to-clear", lockfilePath: lockfilePath)

        let result = LockfileAssistant.setActiveAssistantId(nil, lockfilePath: lockfilePath)
        XCTAssertTrue(result)

        let data = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertNil(json["activeAssistant"])
    }

    func testSetActiveAssistantIdIsNoOpWhenValueUnchanged() {
        LockfileAssistant.setActiveAssistantId("same-id", lockfilePath: lockfilePath)
        let modDate1 = try! FileManager.default.attributesOfItem(atPath: lockfilePath)[.modificationDate] as! Date

        // Brief pause so any rewrite would produce a different mtime.
        Thread.sleep(forTimeInterval: 0.05)

        let result = LockfileAssistant.setActiveAssistantId("same-id", lockfilePath: lockfilePath)
        XCTAssertTrue(result)

        let modDate2 = try! FileManager.default.attributesOfItem(atPath: lockfilePath)[.modificationDate] as! Date
        XCTAssertEqual(modDate1, modDate2, "File should not be rewritten when value is unchanged")
    }

    // MARK: - setActiveAssistantId: notification

    func testSetActiveAssistantIdPostsNotification() {
        let expectation = expectation(forNotification: LockfileAssistant.activeAssistantDidChange, object: nil)

        LockfileAssistant.setActiveAssistantId("notify-test", lockfilePath: lockfilePath)

        wait(for: [expectation], timeout: 2.0)
    }

    func testSetActiveAssistantIdDoesNotPostNotificationWhenValueUnchanged() {
        // Set initial value and drain its async notification before testing the no-op path.
        let setupExpectation = expectation(forNotification: LockfileAssistant.activeAssistantDidChange, object: nil)
        LockfileAssistant.setActiveAssistantId("stable-id", lockfilePath: lockfilePath)
        wait(for: [setupExpectation], timeout: 2.0)

        // Now set up an inverted expectation: notification should NOT fire for the same value.
        let noChangeExpectation = expectation(forNotification: LockfileAssistant.activeAssistantDidChange, object: nil)
        noChangeExpectation.isInverted = true

        LockfileAssistant.setActiveAssistantId("stable-id", lockfilePath: lockfilePath)

        wait(for: [noChangeExpectation], timeout: 0.5)
    }

    // MARK: - Notification name

    func testActiveAssistantDidChangeNotificationName() {
        XCTAssertEqual(
            LockfileAssistant.activeAssistantDidChange.rawValue,
            "LockfileAssistant.activeAssistantDidChange"
        )
    }
}
