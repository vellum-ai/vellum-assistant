import XCTest
@testable import VellumAssistantLib

/// Regression tests for AppListManager.syncFromDaemon().
///
/// These tests verify the sync chain that makes newly-created apps (e.g. from
/// an app_create tool call) appear in the macOS "Things" sidebar after the
/// daemon broadcasts app_files_changed, which triggers a fresh daemon sync.
///
/// The chain under test:
///   app_create tool runs
///   → notifyAppChanged in tool-side-effects.ts broadcasts app_files_changed
///   → macOS client calls /v1/apps, receives updated list
///   → AppListManager.syncFromDaemon() is called with the new list
///   → manager.apps contains the new app
@MainActor
final class AppListManagerSyncTests: XCTestCase {

    private var tempDir: URL!
    private var manager: AppListManager!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let fileURL = tempDir.appendingPathComponent("app-list.json")
        manager = AppListManager(fileURL: fileURL)
    }

    override func tearDown() {
        manager = nil
        try? FileManager.default.removeItem(at: tempDir)
        tempDir = nil
        super.tearDown()
    }

    // MARK: - Helpers

    private func makeDaemonApp(
        id: String = "app-1",
        name: String = "Things",
        description: String? = nil,
        icon: String? = nil,
        appType: String? = nil,
        createdAt: Int = 1_700_000_000_000
    ) -> AppListManager.AppItem_Daemon {
        AppListManager.AppItem_Daemon(
            id: id,
            name: name,
            description: description,
            icon: icon,
            appType: appType,
            createdAt: createdAt
        )
    }

    // MARK: - New app appears after sync

    func testNewAppFromDaemonAppearsAfterSync() {
        // Precondition: manager starts with no apps
        XCTAssertTrue(manager.apps.isEmpty, "Manager should start empty")

        let daemonApp = makeDaemonApp(id: "things-app", name: "Things")
        manager.syncFromDaemon([daemonApp])

        XCTAssertEqual(manager.apps.count, 1, "One app should appear after sync")
        XCTAssertEqual(manager.apps.first?.id, "things-app")
        XCTAssertEqual(manager.apps.first?.name, "Things")
    }

    func testMultipleNewAppsFromDaemonAllAppearAfterSync() {
        let daemonApps = [
            makeDaemonApp(id: "app-a", name: "Alpha"),
            makeDaemonApp(id: "app-b", name: "Bravo"),
            makeDaemonApp(id: "app-c", name: "Charlie"),
        ]
        manager.syncFromDaemon(daemonApps)

        XCTAssertEqual(manager.apps.count, 3)
        let ids = Set(manager.apps.map(\.id))
        XCTAssertEqual(ids, ["app-a", "app-b", "app-c"])
    }

    func testNewAppTimestampDerivesFromDaemonCreatedAt() throws {
        // createdAt is milliseconds since epoch; lastOpenedAt should reflect it
        let createdAtMs = 1_700_000_000_000
        let daemonApp = makeDaemonApp(id: "app-ts", name: "Timestamp App", createdAt: createdAtMs)
        manager.syncFromDaemon([daemonApp])

        let app = try XCTUnwrap(manager.apps.first)
        let expectedDate = Date(timeIntervalSince1970: TimeInterval(createdAtMs) / 1000.0)
        XCTAssertEqual(
            app.lastOpenedAt.timeIntervalSince1970,
            expectedDate.timeIntervalSince1970,
            accuracy: 0.001,
            "lastOpenedAt should be derived from daemon's createdAt millisecond timestamp"
        )
    }

    // MARK: - Description update

    func testExistingAppDescriptionIsUpdatedOnSync() {
        // Seed the manager with an app that has no description
        manager.recordAppOpen(id: "app-1", name: "Things")
        XCTAssertNil(manager.apps.first?.description, "Initial description should be nil")

        // Sync from daemon with a description
        let daemonApp = makeDaemonApp(id: "app-1", name: "Things", description: "A task manager")
        manager.syncFromDaemon([daemonApp])

        XCTAssertEqual(manager.apps.first?.description, "A task manager",
                       "Description should be updated from daemon during sync")
    }

    func testExistingAppDescriptionIsOverwrittenWhenChanged() {
        // Seed with a stale description
        manager.recordAppOpen(id: "app-1", name: "Things", description: "Old description")

        // Daemon reports a new description
        let daemonApp = makeDaemonApp(id: "app-1", name: "Things", description: "New description")
        manager.syncFromDaemon([daemonApp])

        XCTAssertEqual(manager.apps.first?.description, "New description",
                       "Daemon description should overwrite local stale description")
    }

    func testExistingAppNotDuplicatedOnSync() {
        // Seeding an app then syncing the same app should not duplicate it
        manager.recordAppOpen(id: "app-1", name: "Things")
        XCTAssertEqual(manager.apps.count, 1)

        let daemonApp = makeDaemonApp(id: "app-1", name: "Things", description: "Updated")
        manager.syncFromDaemon([daemonApp])

        XCTAssertEqual(manager.apps.count, 1, "Sync should not duplicate an existing app")
    }

    // MARK: - Removed app is pruned

    func testAppRemovedFromDaemonIsPrunedLocally() {
        // Seed two apps
        manager.recordAppOpen(id: "app-keep", name: "Keep Me")
        manager.recordAppOpen(id: "app-gone", name: "Gone App")
        XCTAssertEqual(manager.apps.count, 2)

        // Daemon only reports the first app — second has been deleted
        let daemonApps = [makeDaemonApp(id: "app-keep", name: "Keep Me")]
        manager.syncFromDaemon(daemonApps)

        XCTAssertEqual(manager.apps.count, 1, "Pruned app should be removed")
        XCTAssertEqual(manager.apps.first?.id, "app-keep", "Surviving app should be retained")
        XCTAssertNil(manager.apps.first(where: { $0.id == "app-gone" }),
                     "Removed app should not be in the list")
    }

    func testSyncWithEmptyDaemonListPrunesAllApps() {
        manager.recordAppOpen(id: "app-1", name: "App One")
        manager.recordAppOpen(id: "app-2", name: "App Two")
        XCTAssertEqual(manager.apps.count, 2)

        manager.syncFromDaemon([])

        XCTAssertTrue(manager.apps.isEmpty, "All apps should be pruned when daemon list is empty")
    }

    // MARK: - Tombstoned apps are not re-added by sync

    func testUserRemovedAppIsNotReAddedBySyncFromDaemon() {
        // User removes an app: it is tombstoned in removedAppIds
        manager.recordAppOpen(id: "app-tombstoned", name: "Removed App")
        manager.removeApp(id: "app-tombstoned")
        XCTAssertTrue(manager.apps.isEmpty, "App should be gone after user removal")

        // Daemon still reports it (e.g. daemon hasn't been notified yet)
        let daemonApp = makeDaemonApp(id: "app-tombstoned", name: "Removed App")
        manager.syncFromDaemon([daemonApp])

        XCTAssertTrue(manager.apps.isEmpty,
                      "Tombstoned app should not reappear after daemon sync")
    }

    // MARK: - Pinned apps survive sync

    func testPinnedAppSurvivesSyncAndRetainsPinnedState() {
        manager.recordAppOpen(id: "app-pinned", name: "Pinned App")
        manager.pinApp(id: "app-pinned")
        XCTAssertTrue(manager.apps.first?.isPinned == true, "App should be pinned")

        // Sync with the same app from daemon
        let daemonApp = makeDaemonApp(id: "app-pinned", name: "Pinned App")
        manager.syncFromDaemon([daemonApp])

        // Pinned state is local metadata and should be preserved
        XCTAssertTrue(manager.apps.first?.isPinned == true,
                      "Pinned state should be preserved after sync")
    }

    // MARK: - Mixed scenario: add, update, prune in one sync

    func testSyncCombinedAddUpdateAndPrune() {
        // Seed two existing apps
        manager.recordAppOpen(id: "app-keep", name: "Keep")
        manager.recordAppOpen(id: "app-prune", name: "Prune Me")
        XCTAssertEqual(manager.apps.count, 2)

        // Daemon: keeps "app-keep" (with new description), removes "app-prune", adds "app-new"
        let daemonApps = [
            makeDaemonApp(id: "app-keep", name: "Keep", description: "I am kept"),
            makeDaemonApp(id: "app-new", name: "New App"),
        ]
        manager.syncFromDaemon(daemonApps)

        XCTAssertEqual(manager.apps.count, 2, "Should have kept + new = 2 apps")

        let kept = manager.apps.first(where: { $0.id == "app-keep" })
        XCTAssertNotNil(kept, "app-keep should still exist")
        XCTAssertEqual(kept?.description, "I am kept", "Description should be updated")

        let newApp = manager.apps.first(where: { $0.id == "app-new" })
        XCTAssertNotNil(newApp, "app-new should have been added")

        let pruned = manager.apps.first(where: { $0.id == "app-prune" })
        XCTAssertNil(pruned, "app-prune should have been removed")
    }
}
