import XCTest
@testable import VellumAssistantLib

final class JSONLParserTests: XCTestCase {

    func testEmptyStringReturnsEmptyArray() {
        let result = parseJSONL("")
        guard case .success(let node) = result else { return XCTFail("Expected success") }
        if case .array(_, let elements) = node {
            XCTAssertEqual(elements.count, 0)
        } else {
            XCTFail("Expected array root")
        }
    }

    func testSingleObjectLine() {
        let result = parseJSONL(#"{"a":1}"#)
        guard case .success(.array(_, let elements)) = result else {
            return XCTFail("Expected array root")
        }
        XCTAssertEqual(elements.count, 1)
        if case .object(_, let entries) = elements[0] {
            XCTAssertEqual(entries.count, 1)
            XCTAssertEqual(entries[0].key, "a")
        } else {
            XCTFail("Expected first element to be an object")
        }
    }

    func testMultipleObjectLines() {
        let input = "{\"a\":1}\n{\"b\":2}\n{\"c\":3}"
        let result = parseJSONL(input)
        guard case .success(.array(_, let elements)) = result else {
            return XCTFail("Expected array root")
        }
        XCTAssertEqual(elements.count, 3)
    }

    func testTrailingNewlineIsIgnored() {
        let input = "{\"a\":1}\n{\"b\":2}\n"
        let result = parseJSONL(input)
        guard case .success(.array(_, let elements)) = result else {
            return XCTFail("Expected array root")
        }
        XCTAssertEqual(elements.count, 2, "Trailing newline should not produce an empty element")
    }

    func testBlankLineIsSkipped() {
        let input = "{\"a\":1}\n\n{\"b\":2}"
        let result = parseJSONL(input)
        guard case .success(.array(_, let elements)) = result else {
            return XCTFail("Expected array root")
        }
        XCTAssertEqual(elements.count, 2, "Blank lines should be skipped, not parsed")
    }

    func testCRLFLineEndingsAreHandled() {
        let input = "{\"a\":1}\r\n{\"b\":2}\r\n"
        let result = parseJSONL(input)
        guard case .success(.array(_, let elements)) = result else {
            return XCTFail("Expected array root")
        }
        XCTAssertEqual(elements.count, 2)
    }

    func testInvalidLineSurfacedAsStringNode() {
        let input = "{\"a\":1}\nNOT_VALID_JSON\n{\"b\":2}"
        let result = parseJSONL(input)
        guard case .success(.array(_, let elements)) = result else {
            return XCTFail("Expected array root")
        }
        XCTAssertEqual(elements.count, 3)
        if case .string(_, let value) = elements[1] {
            XCTAssertTrue(value.contains("parse error"))
            XCTAssertTrue(value.contains("line 2"))
            XCTAssertTrue(value.contains("NOT_VALID_JSON"))
        } else {
            XCTFail("Expected second element to be an error string node, got \(elements[1])")
        }
    }

    func testMixedPrimitiveAndObjectLines() {
        // JSONL technically permits any JSON value per line — strings,
        // numbers, booleans, null. parseJSONL must accept fragments.
        let input = "42\n\"hello\"\ntrue\nnull\n{\"k\":\"v\"}"
        let result = parseJSONL(input)
        guard case .success(.array(_, let elements)) = result else {
            return XCTFail("Expected array root")
        }
        XCTAssertEqual(elements.count, 5)
    }

    func testElementPathsAreSequential() {
        // Synthetic array element IDs must use sequential indices, not the
        // raw line numbers — otherwise blank-line-skipping would produce
        // non-contiguous IDs and confuse expandedPaths tracking.
        let input = "{\"a\":1}\n\n{\"b\":2}\n\n{\"c\":3}"
        let result = parseJSONL(input)
        guard case .success(.array(_, let elements)) = result else {
            return XCTFail("Expected array root")
        }
        XCTAssertEqual(elements.count, 3)
        XCTAssertEqual(elements[0].id, "$[0]")
        XCTAssertEqual(elements[1].id, "$[1]")
        XCTAssertEqual(elements[2].id, "$[2]")
    }
}
