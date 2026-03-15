import XCTest
@testable import VellumAssistantLib

final class AvatarAppearanceManagerPathTests: XCTestCase {

    func testWorkspacePathUsesVellumWorkspaceDirectory() {
        let url = AvatarAppearanceManager.workspaceCustomAvatarURL(homeDirectory: "/Users/testuser")
        XCTAssertEqual(url.path, "/Users/testuser/.vellum/workspace/data/avatar/avatar-image.png")
    }

    func testWorkspacePathDefaultsToRealHomeDirectory() {
        let url = AvatarAppearanceManager.workspaceCustomAvatarURL()
        XCTAssertTrue(url.path.hasSuffix("/.vellum/workspace/data/avatar/avatar-image.png"))
        XCTAssertFalse(url.path.isEmpty)
    }

    func testLegacyPathUsesApplicationSupport() {
        let url = AvatarAppearanceManager.legacyAppSupportCustomAvatarURL()
        XCTAssertTrue(url.path.contains("Application Support/vellum-assistant"))
        XCTAssertTrue(url.path.hasSuffix("/custom-avatar.png"))
    }

    func testWorkspaceAndLegacyPathsAreDifferent() {
        let workspace = AvatarAppearanceManager.workspaceCustomAvatarURL()
        let legacy = AvatarAppearanceManager.legacyAppSupportCustomAvatarURL()
        XCTAssertNotEqual(workspace.path, legacy.path)
    }

    func testWorkspacePathIsDeterministicForSameInput() {
        let url1 = AvatarAppearanceManager.workspaceCustomAvatarURL(homeDirectory: "/tmp/test")
        let url2 = AvatarAppearanceManager.workspaceCustomAvatarURL(homeDirectory: "/tmp/test")
        XCTAssertEqual(url1, url2)
    }
}
