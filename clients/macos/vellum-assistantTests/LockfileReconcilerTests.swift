import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

final class LockfileReconcilerTests: XCTestCase {
    private var tempDir: URL!
    private var lockfilePath: String!
    private var runtimeUrl: String!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try! FileManager.default.createDirectory(
            at: tempDir, withIntermediateDirectories: true
        )
        lockfilePath = tempDir.appendingPathComponent(".vellum.lock.json").path
        // The reconciler tags new entries with `runtimeUrl` and the
        // `isCurrentEnvironment` filter compares against
        // `VellumEnvironment.resolvedPlatformURL`. Seed test entries with
        // the same value so the filter matches.
        runtimeUrl = VellumEnvironment.resolvedPlatformURL
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        super.tearDown()
    }

    // MARK: - Add

    func testAddsPlatformAssistantToEmptyLockfile() {
        let result = LockfileReconciler.reconcile(
            platformAssistants: [
                makePlatformAssistant(id: "a-1", createdAt: "2024-01-01T00:00:00Z"),
            ],
            runtimeUrl: runtimeUrl,
            lockfilePath: lockfilePath
        )

        XCTAssertEqual(result.added, ["a-1"])
        XCTAssertEqual(result.removed, [])
        XCTAssertTrue(result.didChange)

        let entries = LockfileAssistant.loadAll(lockfilePath: lockfilePath)
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].assistantId, "a-1")
        XCTAssertTrue(entries[0].isManaged)
    }

    func testAddsMultipleNewPlatformAssistants() {
        let result = LockfileReconciler.reconcile(
            platformAssistants: [
                makePlatformAssistant(id: "a-1", createdAt: "2024-01-01T00:00:00Z"),
                makePlatformAssistant(id: "a-2", createdAt: "2024-02-01T00:00:00Z"),
                makePlatformAssistant(id: "a-3", createdAt: "2024-03-01T00:00:00Z"),
            ],
            runtimeUrl: runtimeUrl,
            lockfilePath: lockfilePath
        )

        XCTAssertEqual(Set(result.added), ["a-1", "a-2", "a-3"])
        XCTAssertEqual(result.removed, [])

        let ids = Set(
            LockfileAssistant.loadAll(lockfilePath: lockfilePath).map(\.assistantId)
        )
        XCTAssertEqual(ids, ["a-1", "a-2", "a-3"])
    }

    func testSkipsAssistantsAlreadyInLockfile() {
        // Seed an existing managed entry.
        LockfileAssistant.ensureManagedEntry(
            assistantId: "a-1",
            runtimeUrl: runtimeUrl,
            hatchedAt: "2024-01-01T00:00:00Z",
            lockfilePath: lockfilePath
        )

        let result = LockfileReconciler.reconcile(
            platformAssistants: [
                makePlatformAssistant(id: "a-1", createdAt: "2024-01-01T00:00:00Z"),
                makePlatformAssistant(id: "a-2", createdAt: "2024-02-01T00:00:00Z"),
            ],
            runtimeUrl: runtimeUrl,
            lockfilePath: lockfilePath
        )

        XCTAssertEqual(result.added, ["a-2"])
        XCTAssertEqual(result.removed, [])

        let ids = Set(
            LockfileAssistant.loadAll(lockfilePath: lockfilePath).map(\.assistantId)
        )
        XCTAssertEqual(ids, ["a-1", "a-2"])
    }

    // MARK: - Remove

    func testRemovesManagedEntryNotOnPlatform() {
        LockfileAssistant.ensureManagedEntry(
            assistantId: "stale-id",
            runtimeUrl: runtimeUrl,
            hatchedAt: "2024-01-01T00:00:00Z",
            lockfilePath: lockfilePath
        )

        let result = LockfileReconciler.reconcile(
            platformAssistants: [],
            runtimeUrl: runtimeUrl,
            lockfilePath: lockfilePath
        )

        XCTAssertEqual(result.added, [])
        XCTAssertEqual(result.removed, ["stale-id"])

        let entries = LockfileAssistant.loadAll(lockfilePath: lockfilePath)
        XCTAssertTrue(entries.isEmpty)
    }

    func testRemovesOnlyAssistantsMissingFromPlatform() {
        LockfileAssistant.ensureManagedEntry(
            assistantId: "keep-id",
            runtimeUrl: runtimeUrl,
            hatchedAt: "2024-01-01T00:00:00Z",
            lockfilePath: lockfilePath
        )
        LockfileAssistant.ensureManagedEntry(
            assistantId: "stale-id",
            runtimeUrl: runtimeUrl,
            hatchedAt: "2024-02-01T00:00:00Z",
            lockfilePath: lockfilePath
        )

        let result = LockfileReconciler.reconcile(
            platformAssistants: [
                makePlatformAssistant(id: "keep-id", createdAt: "2024-01-01T00:00:00Z"),
            ],
            runtimeUrl: runtimeUrl,
            lockfilePath: lockfilePath
        )

        XCTAssertEqual(result.added, [])
        XCTAssertEqual(result.removed, ["stale-id"])

        let ids = LockfileAssistant.loadAll(lockfilePath: lockfilePath)
            .map(\.assistantId)
        XCTAssertEqual(ids, ["keep-id"])
    }

    // MARK: - Non-managed entries are untouched

    func testDoesNotRemoveLocalAssistant() {
        let lockfile: [String: Any] = [
            "assistants": [
                [
                    "assistantId": "local-1",
                    "cloud": "local",
                    "hatchedAt": "2024-01-01T00:00:00Z",
                ]
            ]
        ]
        let data = try! JSONSerialization.data(withJSONObject: lockfile)
        try! data.write(to: URL(fileURLWithPath: lockfilePath))

        let result = LockfileReconciler.reconcile(
            platformAssistants: [],
            runtimeUrl: runtimeUrl,
            lockfilePath: lockfilePath
        )

        XCTAssertEqual(result.added, [])
        XCTAssertEqual(result.removed, [])

        let entries = LockfileAssistant.loadAll(lockfilePath: lockfilePath)
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].assistantId, "local-1")
        XCTAssertFalse(entries[0].isManaged)
    }

    func testDoesNotRemoveDockerOrAppleContainerAssistants() {
        let lockfile: [String: Any] = [
            "assistants": [
                [
                    "assistantId": "docker-1",
                    "cloud": "docker",
                    "hatchedAt": "2024-01-01T00:00:00Z",
                ],
                [
                    "assistantId": "apple-1",
                    "cloud": "apple-container",
                    "hatchedAt": "2024-01-01T00:00:00Z",
                ],
            ]
        ]
        let data = try! JSONSerialization.data(withJSONObject: lockfile)
        try! data.write(to: URL(fileURLWithPath: lockfilePath))

        let result = LockfileReconciler.reconcile(
            platformAssistants: [],
            runtimeUrl: runtimeUrl,
            lockfilePath: lockfilePath
        )

        XCTAssertEqual(result.added, [])
        XCTAssertEqual(result.removed, [])

        let ids = Set(
            LockfileAssistant.loadAll(lockfilePath: lockfilePath).map(\.assistantId)
        )
        XCTAssertEqual(ids, ["docker-1", "apple-1"])
    }

    func testDoesNotRemoveManagedEntryFromDifferentEnvironment() {
        // A managed entry whose runtimeUrl does not match the current build
        // belongs to a different environment and must not be touched.
        let otherEnvUrl = runtimeUrl == "https://platform.vellum.ai"
            ? "https://staging-platform.vellum.ai"
            : "https://platform.vellum.ai"
        let lockfile: [String: Any] = [
            "assistants": [
                [
                    "assistantId": "other-env-id",
                    "cloud": "vellum",
                    "runtimeUrl": otherEnvUrl,
                    "hatchedAt": "2024-01-01T00:00:00Z",
                ]
            ]
        ]
        let data = try! JSONSerialization.data(withJSONObject: lockfile)
        try! data.write(to: URL(fileURLWithPath: lockfilePath))

        let result = LockfileReconciler.reconcile(
            platformAssistants: [],
            runtimeUrl: runtimeUrl,
            lockfilePath: lockfilePath
        )

        XCTAssertEqual(result.added, [])
        XCTAssertEqual(result.removed, [])

        let entries = LockfileAssistant.loadAll(lockfilePath: lockfilePath)
        XCTAssertEqual(entries.map(\.assistantId), ["other-env-id"])
    }

    // MARK: - Combined

    func testAddsAndRemovesInOnePass() {
        // Lockfile starts with one stale managed entry.
        LockfileAssistant.ensureManagedEntry(
            assistantId: "stale",
            runtimeUrl: runtimeUrl,
            hatchedAt: "2024-01-01T00:00:00Z",
            lockfilePath: lockfilePath
        )

        let result = LockfileReconciler.reconcile(
            platformAssistants: [
                makePlatformAssistant(id: "fresh", createdAt: "2024-06-01T00:00:00Z"),
            ],
            runtimeUrl: runtimeUrl,
            lockfilePath: lockfilePath
        )

        XCTAssertEqual(result.added, ["fresh"])
        XCTAssertEqual(result.removed, ["stale"])
        XCTAssertTrue(result.didChange)

        let ids = LockfileAssistant.loadAll(lockfilePath: lockfilePath)
            .map(\.assistantId)
        XCTAssertEqual(ids, ["fresh"])
    }

    // MARK: - No-op

    func testReturnsEmptyResultWhenAlreadyInSync() {
        LockfileAssistant.ensureManagedEntry(
            assistantId: "a-1",
            runtimeUrl: runtimeUrl,
            hatchedAt: "2024-01-01T00:00:00Z",
            lockfilePath: lockfilePath
        )

        let result = LockfileReconciler.reconcile(
            platformAssistants: [
                makePlatformAssistant(id: "a-1", createdAt: "2024-01-01T00:00:00Z"),
            ],
            runtimeUrl: runtimeUrl,
            lockfilePath: lockfilePath
        )

        XCTAssertEqual(result.added, [])
        XCTAssertEqual(result.removed, [])
        XCTAssertFalse(result.didChange)
    }

    func testFallsBackToNowWhenPlatformCreatedAtMissing() {
        var nowCalls = 0
        let fixedNow = "2099-12-31T23:59:59Z"

        let result = LockfileReconciler.reconcile(
            platformAssistants: [
                makePlatformAssistant(id: "no-created", createdAt: nil),
            ],
            runtimeUrl: runtimeUrl,
            lockfilePath: lockfilePath,
            now: {
                nowCalls += 1
                return fixedNow
            }
        )

        XCTAssertEqual(result.added, ["no-created"])
        XCTAssertEqual(nowCalls, 1)

        let data = try! Data(contentsOf: URL(fileURLWithPath: lockfilePath))
        let json = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let assistants = json["assistants"] as! [[String: Any]]
        XCTAssertEqual(assistants[0]["hatchedAt"] as? String, fixedNow)
    }

    // MARK: - Helpers

    private func makePlatformAssistant(
        id: String,
        createdAt: String?
    ) -> PlatformAssistant {
        PlatformAssistant(
            id: id,
            name: nil,
            description: nil,
            created_at: createdAt,
            status: nil,
            recovery_mode: nil,
            machine_id: nil
        )
    }
}
