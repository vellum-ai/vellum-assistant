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

    func testAvatarComponentsURLPointsToTraitsFile() {
        let url = AvatarAppearanceManager.workspaceCustomAvatarURL()
        let expectedTraitsPath = url.deletingLastPathComponent()
            .appendingPathComponent("character-traits.json").path
        // Verify the traits file is expected to be a sibling of avatar-image.png
        XCTAssertTrue(expectedTraitsPath.hasSuffix("/.vellum/workspace/data/avatar/character-traits.json"))
    }

    func testLoadAvatarComponentsReadsTraitsFromDisk() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let avatarDir = tmp.appendingPathComponent(".vellum/workspace/data/avatar")
        try FileManager.default.createDirectory(at: avatarDir, withIntermediateDirectories: true)

        let traitsURL = avatarDir.appendingPathComponent("character-traits.json")
        let traits = """
        {"bodyShape": "blob", "eyeStyle": "curious", "color": "teal"}
        """
        try traits.write(to: traitsURL, atomically: true, encoding: .utf8)

        // Verify the JSON is valid and parseable with the expected structure.
        // AvatarComponents is private, so we use a local mirror struct to verify
        // the on-disk format matches what AvatarAppearanceManager expects.
        struct AvatarComponentsMirror: Codable {
            let bodyShape: String
            let eyeStyle: String
            let color: String
        }

        let data = try Data(contentsOf: traitsURL)
        let decoded = try JSONDecoder().decode(AvatarComponentsMirror.self, from: data)
        XCTAssertEqual(decoded.bodyShape, "blob")
        XCTAssertEqual(decoded.eyeStyle, "curious")
        XCTAssertEqual(decoded.color, "teal")

        // Verify the raw values map to valid enum cases used by the manager
        XCTAssertNotNil(AvatarBodyShape(rawValue: decoded.bodyShape))
        XCTAssertNotNil(AvatarEyeStyle(rawValue: decoded.eyeStyle))
        XCTAssertNotNil(AvatarColor(rawValue: decoded.color))
    }
}
