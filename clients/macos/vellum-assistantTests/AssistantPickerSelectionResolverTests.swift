import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

@MainActor
final class AssistantPickerSelectionResolverTests: XCTestCase {
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
        tempDir = nil
        lockfilePath = nil
        super.tearDown()
    }

    func testPickerItemsIncludeLocalAndPlatformOnlyAssistants() {
        let local = makeLocalAssistant(id: "local-1")
        let platform = PlatformAssistant(id: "managed-1", name: "Cloud Assistant")
        let landscape = ReturningUserRouter.AssistantLandscape(
            lockfileAssistants: [local],
            platformAssistants: [platform],
            platformWasConsulted: true
        )

        let items = AssistantPickerItem.from(landscape: landscape)

        XCTAssertEqual(items.map(\.id), ["local-1", "managed-1"])
        XCTAssertEqual(items.map(\.subtitle), ["Local", "Managed"])
        XCTAssertEqual(items.map(\.isManaged), [false, true])
    }

    func testResolvingPlatformOnlySelectionPersistsManagedLockfileEntry() throws {
        let platform = PlatformAssistant(
            id: "managed-1",
            name: "Cloud Assistant",
            created_at: "2026-01-01T00:00:00Z"
        )

        let resolved = AssistantPickerSelectionResolver.resolveLockfileAssistant(
            assistantId: "managed-1",
            platformAssistants: ["managed-1": platform],
            lockfilePath: lockfilePath,
            runtimeURL: "https://platform.example.com"
        )

        XCTAssertEqual(resolved?.assistantId, "managed-1")
        XCTAssertEqual(resolved?.cloud, "vellum")
        XCTAssertEqual(resolved?.runtimeUrl, "https://platform.example.com")
        XCTAssertEqual(resolved?.hatchedAt, "2026-01-01T00:00:00Z")

        let persisted = LockfileAssistant.loadByName("managed-1", lockfilePath: lockfilePath)
        XCTAssertEqual(persisted?.cloud, "vellum")
        XCTAssertEqual(persisted?.runtimeUrl, "https://platform.example.com")
    }

    func testResolvingExistingSelectionKeepsLocalLockfileEntry() throws {
        try writeLockfile([
            "assistants": [
                [
                    "assistantId": "local-1",
                    "cloud": "local",
                    "hatchedAt": "2026-01-01T00:00:00Z",
                ],
            ],
        ])

        let resolved = AssistantPickerSelectionResolver.resolveLockfileAssistant(
            assistantId: "local-1",
            platformAssistants: [:],
            lockfilePath: lockfilePath,
            runtimeURL: "https://platform.example.com"
        )

        XCTAssertEqual(resolved?.assistantId, "local-1")
        XCTAssertEqual(resolved?.cloud, "local")
        XCTAssertNil(resolved?.runtimeUrl)
    }

    private func makeLocalAssistant(id: String) -> LockfileAssistant {
        LockfileAssistant(
            assistantId: id,
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
    }

    private func writeLockfile(_ json: [String: Any]) throws {
        let data = try JSONSerialization.data(
            withJSONObject: json,
            options: [.prettyPrinted, .sortedKeys]
        )
        try data.write(to: URL(fileURLWithPath: lockfilePath), options: .atomic)
    }
}
