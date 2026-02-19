import XCTest
@testable import VellumAssistantLib

final class AvatarAppearanceManagerMigrationTests: XCTestCase {

    func testMigrationCopiesLegacyFileToWorkspace() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let fm = FileManager.default

        // Set up a fake legacy file
        let legacyDir = tmp.appendingPathComponent("legacy")
        try fm.createDirectory(at: legacyDir, withIntermediateDirectories: true)
        let legacyFile = legacyDir.appendingPathComponent("custom-avatar.png")
        let testData = Data([0x89, 0x50, 0x4E, 0x47]) // PNG magic bytes
        try testData.write(to: legacyFile)

        // Set up workspace destination (no file yet)
        let workspaceDir = tmp.appendingPathComponent("workspace/data/avatar")
        try fm.createDirectory(at: workspaceDir, withIntermediateDirectories: true)
        let workspaceFile = workspaceDir.appendingPathComponent("custom-avatar.png")

        // Simulate migration: workspace missing + legacy present => copy
        XCTAssertFalse(fm.fileExists(atPath: workspaceFile.path))
        XCTAssertTrue(fm.fileExists(atPath: legacyFile.path))
        try fm.copyItem(at: legacyFile, to: workspaceFile)
        XCTAssertTrue(fm.fileExists(atPath: workspaceFile.path))

        // Verify content matches
        let copied = try Data(contentsOf: workspaceFile)
        XCTAssertEqual(copied, testData)

        // Legacy file should still exist (not moved)
        XCTAssertTrue(fm.fileExists(atPath: legacyFile.path))

        try? fm.removeItem(at: tmp)
    }

    func testWorkspaceFileWinsOverLegacy() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let fm = FileManager.default

        // Create both files with different content
        let legacyDir = tmp.appendingPathComponent("legacy")
        try fm.createDirectory(at: legacyDir, withIntermediateDirectories: true)
        try Data([0x01]).write(to: legacyDir.appendingPathComponent("avatar.png"))

        let workspaceDir = tmp.appendingPathComponent("workspace")
        try fm.createDirectory(at: workspaceDir, withIntermediateDirectories: true)
        let workspaceFile = workspaceDir.appendingPathComponent("avatar.png")
        try Data([0x02]).write(to: workspaceFile)

        // When workspace exists, it takes precedence
        XCTAssertTrue(fm.fileExists(atPath: workspaceFile.path))
        let data = try Data(contentsOf: workspaceFile)
        XCTAssertEqual(data, Data([0x02]))

        try? fm.removeItem(at: tmp)
    }

    func testNoCrashWhenNeitherFileExists() {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let fm = FileManager.default

        let workspaceFile = tmp.appendingPathComponent("workspace/custom-avatar.png")
        let legacyFile = tmp.appendingPathComponent("legacy/custom-avatar.png")

        // Neither file exists — no crash
        XCTAssertFalse(fm.fileExists(atPath: workspaceFile.path))
        XCTAssertFalse(fm.fileExists(atPath: legacyFile.path))
    }
}
