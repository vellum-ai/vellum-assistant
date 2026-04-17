import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

@MainActor
final class AppDelegateAssistantTopologyTests: XCTestCase {
    private var tempDir: URL!
    private var lockfilePath: String!
    private var appDelegate: AppDelegate!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try! FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        lockfilePath = tempDir.appendingPathComponent(".vellum.lock.json").path
        appDelegate = AppDelegate()
    }

    override func tearDown() {
        appDelegate = nil
        try? FileManager.default.removeItem(at: tempDir)
        tempDir = nil
        lockfilePath = nil
        super.tearDown()
    }

    func testRefreshCurrentAssistantTopologyOverridesStaleManagedFlagsForLocalAssistant() {
        appDelegate.isCurrentAssistantManaged = true
        appDelegate.isCurrentAssistantRemote = true
        appDelegate.isCurrentAssistantDocker = false

        writeLockfile(
            activeAssistant: "local-a",
            assistants: [makeAssistantEntry(id: "local-a", cloud: "local")]
        )

        let assistant = appDelegate.refreshCurrentAssistantTopology(lockfilePath: lockfilePath)

        XCTAssertEqual(assistant?.assistantId, "local-a")
        XCTAssertFalse(appDelegate.isCurrentAssistantManaged)
        XCTAssertFalse(appDelegate.isCurrentAssistantRemote)
        XCTAssertFalse(appDelegate.isCurrentAssistantDocker)
    }

    func testRefreshCurrentAssistantTopologyClearsFlagsWhenNoActiveAssistantExists() {
        appDelegate.isCurrentAssistantManaged = true
        appDelegate.isCurrentAssistantRemote = true
        appDelegate.isCurrentAssistantDocker = false

        writeLockfile(
            activeAssistant: nil,
            assistants: [makeAssistantEntry(
                id: "managed-a",
                cloud: "vellum",
                runtimeUrl: "https://platform.example.com"
            )]
        )

        let assistant = appDelegate.refreshCurrentAssistantTopology(lockfilePath: lockfilePath)

        XCTAssertNil(assistant)
        XCTAssertFalse(appDelegate.isCurrentAssistantManaged)
        XCTAssertFalse(appDelegate.isCurrentAssistantRemote)
        XCTAssertFalse(appDelegate.isCurrentAssistantDocker)
    }

    private func writeLockfile(activeAssistant: String?, assistants: [[String: Any]]) {
        var lockfile: [String: Any] = [
            "assistants": assistants
        ]
        if let activeAssistant {
            lockfile["activeAssistant"] = activeAssistant
        }
        let data = try! JSONSerialization.data(withJSONObject: lockfile)
        try! data.write(to: URL(fileURLWithPath: lockfilePath))
    }

    private func makeAssistantEntry(
        id: String,
        cloud: String,
        runtimeUrl: String? = nil
    ) -> [String: Any] {
        var entry: [String: Any] = [
            "assistantId": id,
            "cloud": cloud,
            "hatchedAt": "2026-04-17T00:00:00Z",
        ]
        if let runtimeUrl {
            entry["runtimeUrl"] = runtimeUrl
        }
        return entry
    }
}
