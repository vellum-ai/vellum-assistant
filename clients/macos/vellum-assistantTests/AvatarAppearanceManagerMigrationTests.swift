import XCTest
@testable import VellumAssistantLib

final class AvatarAppearanceManagerMigrationTests: XCTestCase {

    func testMigrationCopiesLegacyToWorkspaceWhenWorkspaceAbsent() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let legacyURL = tmp.appendingPathComponent("AppSupport/vellum-assistant/custom-avatar.png")
        let workspaceURL = tmp.appendingPathComponent(".vellum/workspace/data/avatar/avatar-image.png")

        try FileManager.default.createDirectory(at: legacyURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let testData = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        try testData.write(to: legacyURL)

        let result = AvatarAppearanceManager.resolveCustomAvatarURL(
            workspaceURL: workspaceURL,
            legacyURL: legacyURL
        )

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
        let workspaceURL = tmp.appendingPathComponent(".vellum/workspace/data/avatar/avatar-image.png")

        try FileManager.default.createDirectory(at: legacyURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0x01]).write(to: legacyURL)
        try FileManager.default.createDirectory(at: workspaceURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0x02]).write(to: workspaceURL)

        let result = AvatarAppearanceManager.resolveCustomAvatarURL(
            workspaceURL: workspaceURL,
            legacyURL: legacyURL
        )

        XCTAssertEqual(result, workspaceURL)
        XCTAssertEqual(try Data(contentsOf: workspaceURL), Data([0x02]))
    }

    func testFallsBackToLegacyWhenCopyFails() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer {
            // Remove read-only attr before cleanup
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o755],
                ofItemAtPath: tmp.appendingPathComponent(".vellum/workspace/data/avatar").path
            )
            try? FileManager.default.removeItem(at: tmp)
        }

        let legacyURL = tmp.appendingPathComponent("AppSupport/vellum-assistant/custom-avatar.png")
        let workspaceURL = tmp.appendingPathComponent(".vellum/workspace/data/avatar/avatar-image.png")

        // Set up legacy file
        try FileManager.default.createDirectory(at: legacyURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0x03]).write(to: legacyURL)

        // Create workspace parent dir as read-only so copyItem fails
        let workspaceDir = workspaceURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: workspaceDir, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o444], ofItemAtPath: workspaceDir.path)

        let result = AvatarAppearanceManager.resolveCustomAvatarURL(
            workspaceURL: workspaceURL,
            legacyURL: legacyURL
        )

        // Copy should have failed; resolver should fall back to legacy
        XCTAssertEqual(result, legacyURL)
        XCTAssertFalse(FileManager.default.fileExists(atPath: workspaceURL.path))
    }

    func testReturnsNilWhenNeitherFileExists() {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let workspaceURL = tmp.appendingPathComponent(".vellum/workspace/data/avatar/avatar-image.png")
        let legacyURL = tmp.appendingPathComponent("AppSupport/vellum-assistant/custom-avatar.png")

        let result = AvatarAppearanceManager.resolveCustomAvatarURL(
            workspaceURL: workspaceURL,
            legacyURL: legacyURL
        )
        XCTAssertNil(result)
    }

    func testPathHelpersProduceCorrectURLsForMigration() {
        let workspace = AvatarAppearanceManager.workspaceCustomAvatarURL(homeDirectory: "/Users/test")
        XCTAssertEqual(workspace.path, "/Users/test/.vellum/workspace/data/avatar/avatar-image.png")

        let legacy = AvatarAppearanceManager.legacyAppSupportCustomAvatarURL()
        XCTAssertTrue(legacy.path.contains("Application Support/vellum-assistant/custom-avatar.png"))
    }
}
