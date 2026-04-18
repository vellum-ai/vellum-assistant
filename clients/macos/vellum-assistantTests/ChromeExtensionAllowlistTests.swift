import Foundation
import XCTest
@testable import VellumAssistantLib

final class ChromeExtensionAllowlistTests: XCTestCase {
    private var tempDir: URL!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("ChromeExtensionAllowlistTests-\(UUID().uuidString)", isDirectory: true)
        try! FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        super.tearDown()
    }

    func testMergedIdsCombinesCanonicalLocalAndEnvironmentInStableOrder() throws {
        let canonicalPath = tempDir.appendingPathComponent("canonical.json")
        let localPath = tempDir.appendingPathComponent("local.json")

        try writeAllowlist(
            at: canonicalPath,
            ids: [
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "invalid",
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ]
        )
        try writeAllowlist(
            at: localPath,
            ids: [
                "cccccccccccccccccccccccccccccccc",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ]
        )

        let merged = ChromeExtensionAllowlist.mergedIds(
            canonicalCandidates: [canonicalPath],
            localOverridePath: localPath,
            environment: [
                "VELLUM_CHROME_EXTENSION_IDS": "dddddddddddddddddddddddddddddddd cccccccccccccccccccccccccccccccc bad-id",
                "VELLUM_CHROME_EXTENSION_ID": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            ]
        )

        XCTAssertEqual(
            merged,
            [
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "cccccccccccccccccccccccccccccccc",
                "dddddddddddddddddddddddddddddddd",
                "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            ]
        )
    }

    func testMergedIdsFallsBackToLaterCanonicalCandidateWhenFirstMissing() throws {
        let missingCanonicalPath = tempDir.appendingPathComponent("missing.json")
        let canonicalPath = tempDir.appendingPathComponent("canonical.json")
        let localPath = tempDir.appendingPathComponent("local.json")

        try writeAllowlist(
            at: canonicalPath,
            ids: ["ffffffffffffffffffffffffffffffff"]
        )
        try writeAllowlist(at: localPath, ids: [])

        let merged = ChromeExtensionAllowlist.mergedIds(
            canonicalCandidates: [missingCanonicalPath, canonicalPath],
            localOverridePath: localPath,
            environment: [:]
        )

        XCTAssertEqual(merged, ["ffffffffffffffffffffffffffffffff"])
    }

    func testMergedIdsReturnsEmptyWhenNoSourceProvidesValidIds() throws {
        let missingCanonicalPath = tempDir.appendingPathComponent("missing.json")
        let localPath = tempDir.appendingPathComponent("local.json")

        try writeAllowlist(at: localPath, ids: ["not-valid"])

        let merged = ChromeExtensionAllowlist.mergedIds(
            canonicalCandidates: [missingCanonicalPath],
            localOverridePath: localPath,
            environment: [
                "VELLUM_CHROME_EXTENSION_IDS": "still-invalid",
                "VELLUM_CHROME_EXTENSION_ID": "also-invalid",
            ]
        )

        XCTAssertEqual(merged, [])
    }

    private func writeAllowlist(at url: URL, ids: [String]) throws {
        let object: [String: Any] = [
            "version": 1,
            "allowedExtensionIds": ids,
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
    }
}
