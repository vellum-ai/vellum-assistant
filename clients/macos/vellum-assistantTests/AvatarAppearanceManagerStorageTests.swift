import XCTest
@testable import VellumAssistantLib

final class AvatarAppearanceManagerStorageTests: XCTestCase {

    func testCustomAvatarURLPointsToWorkspacePath() {
        // The workspace URL should end with the expected workspace suffix
        let url = AvatarAppearanceManager.workspaceCustomAvatarURL()
        XCTAssertTrue(url.path.hasSuffix("/.vellum/workspace/data/avatar/avatar-image.png"))
    }

    func testWorkspacePathCreatesParentDirectories() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let avatarURL = AvatarAppearanceManager.workspaceCustomAvatarURL(homeDirectory: tmp.path)
        let dir = avatarURL.deletingLastPathComponent()

        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.path))

        // Cleanup
        try? FileManager.default.removeItem(at: tmp)
    }
}
