import XCTest
@testable import VellumAssistantLib

final class SyntaxLanguageTests: XCTestCase {
    func testJsonExtensionMapsToJson() {
        XCTAssertEqual(SyntaxLanguage.detect(fileName: "data.json", mimeType: ""), .json)
    }

    func testJsonlExtensionMapsToJson() {
        XCTAssertEqual(SyntaxLanguage.detect(fileName: "messages.jsonl", mimeType: ""), .json)
    }

    func testNdjsonExtensionMapsToJson() {
        XCTAssertEqual(SyntaxLanguage.detect(fileName: "events.ndjson", mimeType: ""), .json)
    }

    func testUppercaseJsonlExtensionMapsToJson() {
        XCTAssertEqual(SyntaxLanguage.detect(fileName: "DATA.JSONL", mimeType: ""), .json)
    }

    func testApplicationJsonlMimeMapsToJson() {
        XCTAssertEqual(SyntaxLanguage.detect(fileName: "anything.txt", mimeType: "application/jsonl"), .json)
    }

    func testApplicationXNdjsonMimeMapsToJson() {
        XCTAssertEqual(SyntaxLanguage.detect(fileName: "anything.txt", mimeType: "application/x-ndjson"), .json)
    }

    func testApplicationXJsonlinesMimeMapsToJson() {
        XCTAssertEqual(SyntaxLanguage.detect(fileName: "anything.txt", mimeType: "application/x-jsonlines"), .json)
    }

    func testUnknownExtensionMapsToPlain() {
        XCTAssertEqual(SyntaxLanguage.detect(fileName: "data.unknown", mimeType: ""), .plain)
    }

    func testJavascriptStillMapsCorrectly() {
        XCTAssertEqual(SyntaxLanguage.detect(fileName: "app.js", mimeType: ""), .javascript)
    }
}
