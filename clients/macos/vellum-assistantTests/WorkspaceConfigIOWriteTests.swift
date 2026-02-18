import XCTest
@testable import VellumAssistantLib

final class WorkspaceConfigIOWriteTests: XCTestCase {

    private var tempDir: URL!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        super.tearDown()
    }

    // MARK: - Helpers

    private var configPath: String {
        tempDir.appendingPathComponent("config.json").path
    }

    /// Write a string to the config file for pre-population.
    private func seed(_ content: String) {
        let url = URL(fileURLWithPath: configPath)
        try! content.write(to: url, atomically: true, encoding: .utf8)
    }

    // MARK: - Writing to new file

    func testMergeCreatesFileWhenMissing() throws {
        try WorkspaceConfigIO.merge(["theme": "dark"], into: configPath)

        let config = WorkspaceConfigIO.read(from: configPath)
        XCTAssertEqual(config["theme"] as? String, "dark")
    }

    func testMergeCreatesValidJson() throws {
        try WorkspaceConfigIO.merge(["key": "value"], into: configPath)

        let data = try Data(contentsOf: URL(fileURLWithPath: configPath))
        let json = try JSONSerialization.jsonObject(with: data, options: [])
        XCTAssertNotNil(json as? [String: Any])
    }

    // MARK: - Preserving existing keys

    func testMergePreservesExistingKeys() throws {
        seed(#"{"existing":"keep","count":42}"#)

        try WorkspaceConfigIO.merge(["newKey": "newValue"], into: configPath)

        let config = WorkspaceConfigIO.read(from: configPath)
        XCTAssertEqual(config["existing"] as? String, "keep")
        XCTAssertEqual(config["count"] as? Int, 42)
        XCTAssertEqual(config["newKey"] as? String, "newValue")
    }

    // MARK: - Overwriting a specific key

    func testMergeOverwritesSpecificKey() throws {
        seed(#"{"theme":"light","fontSize":14}"#)

        try WorkspaceConfigIO.merge(["theme": "dark"], into: configPath)

        let config = WorkspaceConfigIO.read(from: configPath)
        XCTAssertEqual(config["theme"] as? String, "dark")
        XCTAssertEqual(config["fontSize"] as? Int, 14)
    }

    // MARK: - Nested values

    func testMergeWritesNestedValues() throws {
        try WorkspaceConfigIO.merge(
            ["editor": ["tabSize": 4, "wordWrap": true] as [String: Any]],
            into: configPath
        )

        let config = WorkspaceConfigIO.read(from: configPath)
        let editor = config["editor"] as? [String: Any]
        XCTAssertNotNil(editor)
        XCTAssertEqual(editor?["tabSize"] as? Int, 4)
        XCTAssertEqual(editor?["wordWrap"] as? Bool, true)
    }

    // MARK: - Multiple keys at once

    func testMergeMultipleKeys() throws {
        try WorkspaceConfigIO.merge(
            ["a": 1, "b": "two", "c": true],
            into: configPath
        )

        let config = WorkspaceConfigIO.read(from: configPath)
        XCTAssertEqual(config["a"] as? Int, 1)
        XCTAssertEqual(config["b"] as? String, "two")
        XCTAssertEqual(config["c"] as? Bool, true)
    }

    // MARK: - Directory creation

    func testMergeCreatesIntermediateDirectories() throws {
        let nestedPath = tempDir
            .appendingPathComponent("deep/nested/dir", isDirectory: true)
            .appendingPathComponent("config.json")
            .path

        try WorkspaceConfigIO.merge(["key": "value"], into: nestedPath)

        let config = WorkspaceConfigIO.read(from: nestedPath)
        XCTAssertEqual(config["key"] as? String, "value")
    }

    // MARK: - Atomic write safety

    func testAtomicWriteDoesNotCorruptExistingFile() throws {
        seed(#"{"important":"data"}"#)

        // Merge additional data — the original key must survive.
        try WorkspaceConfigIO.merge(["extra": "info"], into: configPath)

        let config = WorkspaceConfigIO.read(from: configPath)
        XCTAssertEqual(config["important"] as? String, "data")
        XCTAssertEqual(config["extra"] as? String, "info")
    }

    func testAtomicWriteNoTempFileLeftBehind() throws {
        try WorkspaceConfigIO.merge(["key": "value"], into: configPath)

        let contents = try FileManager.default.contentsOfDirectory(atPath: tempDir.path)
        // Only the config file should remain — no .tmp artefacts.
        XCTAssertEqual(contents.count, 1)
        XCTAssertEqual(contents.first, "config.json")
    }

    // MARK: - Empty merge is a no-op on content

    func testMergeEmptyDictPreservesExisting() throws {
        seed(#"{"keep":"me"}"#)

        try WorkspaceConfigIO.merge([:], into: configPath)

        let config = WorkspaceConfigIO.read(from: configPath)
        XCTAssertEqual(config["keep"] as? String, "me")
    }

    // MARK: - Overwrites malformed file gracefully

    func testMergeOverwritesMalformedFile() throws {
        seed("{not valid json!!!")

        try WorkspaceConfigIO.merge(["fresh": "start"], into: configPath)

        let config = WorkspaceConfigIO.read(from: configPath)
        XCTAssertEqual(config["fresh"] as? String, "start")
        // Malformed content is replaced; only the merged key should exist.
        XCTAssertEqual(config.count, 1)
    }
}
