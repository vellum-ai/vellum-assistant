import XCTest
@testable import VellumAssistantLib

final class WorkspaceConfigIOReadTests: XCTestCase {

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

    /// Write a string to a temp file and return its path.
    private func writeTemp(_ content: String, filename: String = "config.json") -> String {
        let fileURL = tempDir.appendingPathComponent(filename)
        try? content.write(to: fileURL, atomically: true, encoding: .utf8)
        return fileURL.path
    }

    /// Write raw bytes to a temp file and return its path.
    private func writeTempData(_ data: Data, filename: String = "config.json") -> String {
        let fileURL = tempDir.appendingPathComponent(filename)
        try? data.write(to: fileURL)
        return fileURL.path
    }

    // MARK: - Valid JSON

    func testReadValidJsonReturnsExpectedKeys() {
        let path = writeTemp(#"{"theme":"dark","fontSize":14}"#)
        let config = WorkspaceConfigIO.read(from: path)

        XCTAssertEqual(config["theme"] as? String, "dark")
        XCTAssertEqual(config["fontSize"] as? Int, 14)
    }

    func testReadValidNestedJsonPreservesStructure() {
        let path = writeTemp(#"{"editor":{"tabSize":2},"enabled":true}"#)
        let config = WorkspaceConfigIO.read(from: path)

        XCTAssertEqual(config.count, 2)
        XCTAssertEqual(config["enabled"] as? Bool, true)

        let editor = config["editor"] as? [String: Any]
        XCTAssertNotNil(editor)
        XCTAssertEqual(editor?["tabSize"] as? Int, 2)
    }

    func testReadEmptyObjectReturnsEmptyDict() {
        let path = writeTemp("{}")
        let config = WorkspaceConfigIO.read(from: path)

        XCTAssertTrue(config.isEmpty)
    }

    // MARK: - Missing file

    func testReadMissingFileReturnsEmptyDict() {
        let bogusPath = tempDir.appendingPathComponent("nonexistent.json").path
        let config = WorkspaceConfigIO.read(from: bogusPath)

        XCTAssertTrue(config.isEmpty)
    }

    // MARK: - Empty file

    func testReadEmptyFileReturnsEmptyDict() {
        let path = writeTempData(Data())
        let config = WorkspaceConfigIO.read(from: path)

        XCTAssertTrue(config.isEmpty)
    }

    // MARK: - Malformed JSON

    func testReadMalformedJsonReturnsEmptyDict() {
        let path = writeTemp("{not valid json!!!")
        let config = WorkspaceConfigIO.read(from: path)

        XCTAssertTrue(config.isEmpty)
    }

    func testReadTrailingCommaIsTolerated() {
        // Apple's JSONSerialization is lenient and accepts trailing commas
        let path = writeTemp(#"{"key": "value",}"#)
        let config = WorkspaceConfigIO.read(from: path)

        XCTAssertEqual(config["key"] as? String, "value")
    }

    // MARK: - Non-object JSON

    func testReadArrayRootReturnsEmptyDict() {
        let path = writeTemp(#"[1, 2, 3]"#)
        let config = WorkspaceConfigIO.read(from: path)

        XCTAssertTrue(config.isEmpty)
    }

    func testReadStringRootReturnsEmptyDict() {
        let path = writeTemp(#""just a string""#)
        let config = WorkspaceConfigIO.read(from: path)

        XCTAssertTrue(config.isEmpty)
    }

    func testReadNumberRootReturnsEmptyDict() {
        let path = writeTemp("42")
        let config = WorkspaceConfigIO.read(from: path)

        XCTAssertTrue(config.isEmpty)
    }

    func testReadBoolRootReturnsEmptyDict() {
        let path = writeTemp("true")
        let config = WorkspaceConfigIO.read(from: path)

        XCTAssertTrue(config.isEmpty)
    }

    func testReadNullRootReturnsEmptyDict() {
        let path = writeTemp("null")
        let config = WorkspaceConfigIO.read(from: path)

        XCTAssertTrue(config.isEmpty)
    }

    // MARK: - Default path

    func testDefaultPathPointsToExpectedLocation() {
        let home = NSHomeDirectory()
        XCTAssertEqual(WorkspaceConfigIO.defaultPath, "\(home)/.vellum/workspace/config.json")
    }
}
