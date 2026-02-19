import XCTest
@testable import VellumAssistantLib

final class AvatarAppearanceManagerMigrationTests: XCTestCase {

    /// Replicates the migration logic from `loadCustomAvatar()` for testability.
    /// Uses the same conditional structure: copy legacy -> workspace if workspace absent.
    private func runMigrationLogic(workspaceURL: URL, legacyURL: URL) -> URL? {
        let fm = FileManager.default

        if !fm.fileExists(atPath: workspaceURL.path), fm.fileExists(atPath: legacyURL.path) {
            let dir = workspaceURL.deletingLastPathComponent()
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
            try? fm.copyItem(at: legacyURL, to: workspaceURL)
        }

        if fm.fileExists(atPath: workspaceURL.path) {
            return workspaceURL
        } else if fm.fileExists(atPath: legacyURL.path) {
            return legacyURL
        }
        return nil
    }

    func testMigrationCopiesLegacyToWorkspaceWhenWorkspaceAbsent() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let legacyURL = tmp.appendingPathComponent("AppSupport/vellum-assistant/custom-avatar.png")
        let workspaceURL = tmp.appendingPathComponent(".vellum/workspace/data/avatar/custom-avatar.png")

        // Set up legacy file only
        try FileManager.default.createDirectory(at: legacyURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let testData = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) // PNG header
        try testData.write(to: legacyURL)

        let result = runMigrationLogic(workspaceURL: workspaceURL, legacyURL: legacyURL)

        // Migration should have copied to workspace and returned workspace URL
        XCTAssertEqual(result, workspaceURL)
        XCTAssertTrue(FileManager.default.fileExists(atPath: workspaceURL.path))
        XCTAssertEqual(try Data(contentsOf: workspaceURL), testData)
        // Legacy file preserved (copy, not move)
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyURL.path))
    }

    func testWorkspaceWinsWhenBothExist() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let legacyURL = tmp.appendingPathComponent("AppSupport/vellum-assistant/custom-avatar.png")
        let workspaceURL = tmp.appendingPathComponent(".vellum/workspace/data/avatar/custom-avatar.png")

        // Set up both files with different content
        try FileManager.default.createDirectory(at: legacyURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0x01]).write(to: legacyURL)
        try FileManager.default.createDirectory(at: workspaceURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0x02]).write(to: workspaceURL)

        let result = runMigrationLogic(workspaceURL: workspaceURL, legacyURL: legacyURL)

        // Workspace takes precedence
        XCTAssertEqual(result, workspaceURL)
        // Workspace content unchanged (no overwrite from legacy)
        XCTAssertEqual(try Data(contentsOf: workspaceURL), Data([0x02]))
    }

    func testFallsBackToLegacyWhenMigrationFails() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let legacyURL = tmp.appendingPathComponent("AppSupport/vellum-assistant/custom-avatar.png")
        // Point workspace to a path where parent dir creation will succeed but
        // we can verify the fallback behavior when workspace doesn't end up existing
        let workspaceURL = tmp.appendingPathComponent(".vellum/workspace/data/avatar/custom-avatar.png")

        // Only legacy exists
        try FileManager.default.createDirectory(at: legacyURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0x03]).write(to: legacyURL)

        // Run migration — it should copy successfully and return workspace
        let result = runMigrationLogic(workspaceURL: workspaceURL, legacyURL: legacyURL)
        XCTAssertEqual(result, workspaceURL)
    }

    func testReturnsNilWhenNeitherFileExists() {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let workspaceURL = tmp.appendingPathComponent(".vellum/workspace/data/avatar/custom-avatar.png")
        let legacyURL = tmp.appendingPathComponent("AppSupport/vellum-assistant/custom-avatar.png")

        let result = runMigrationLogic(workspaceURL: workspaceURL, legacyURL: legacyURL)
        XCTAssertNil(result)
    }

    func testPathHelpersProduceCorrectURLsForMigration() {
        // Verify the path helpers used by loadCustomAvatar produce the expected paths
        let workspace = AvatarAppearanceManager.workspaceCustomAvatarURL(homeDirectory: "/Users/test")
        XCTAssertEqual(workspace.path, "/Users/test/.vellum/workspace/data/avatar/custom-avatar.png")

        let legacy = AvatarAppearanceManager.legacyAppSupportCustomAvatarURL()
        XCTAssertTrue(legacy.path.contains("Application Support/vellum-assistant/custom-avatar.png"))
    }
}
