import XCTest
@testable import VellumAssistantLib

final class InlineThinkingTagParserTests: XCTestCase {
    func testNoTagsReturnsSingleTextChunk() {
        let chunks = parseInlineThinkingTags("just a normal response")
        XCTAssertEqual(chunks, [.text("just a normal response")])
    }

    func testEmptyInputReturnsSingleEmptyTextChunk() {
        // Fast path: no `<thinking>` substring, returns whole string as-is.
        let chunks = parseInlineThinkingTags("")
        XCTAssertEqual(chunks, [.text("")])
    }

    func testSingleClosedThinkingBlockAtStart() {
        let input = "<thinking>planning the response</thinking>\n\nhere's my answer"
        let chunks = parseInlineThinkingTags(input)
        XCTAssertEqual(chunks.count, 2)
        XCTAssertEqual(chunks[0], .thinking("planning the response"))
        if case .text(let body) = chunks[1] {
            XCTAssertEqual(body.trimmingCharacters(in: .whitespacesAndNewlines), "here's my answer")
        } else {
            XCTFail("expected second chunk to be text")
        }
    }

    func testThinkingOnlyProducesSingleThinkingChunk() {
        let input = "<thinking>just reasoning, no response yet</thinking>"
        let chunks = parseInlineThinkingTags(input)
        XCTAssertEqual(chunks, [.thinking("just reasoning, no response yet")])
    }

    func testUnclosedTagTreatsRemainderAsStreamingThinking() {
        // During streaming the closing tag may not have arrived yet.
        // The partial thinking content should still render inside a
        // collapsible block instead of flashing raw markup.
        let input = "<thinking>still figuring this out"
        let chunks = parseInlineThinkingTags(input)
        XCTAssertEqual(chunks, [.thinking("still figuring this out")])
    }

    func testTextBeforeUnclosedTagIsPreserved() {
        let input = "prelude text <thinking>mid-thought"
        let chunks = parseInlineThinkingTags(input)
        XCTAssertEqual(chunks.count, 2)
        if case .text(let body) = chunks[0] {
            XCTAssertEqual(body.trimmingCharacters(in: .whitespacesAndNewlines), "prelude text")
        } else {
            XCTFail("expected first chunk to be text")
        }
        XCTAssertEqual(chunks[1], .thinking("mid-thought"))
    }

    func testMultipleThinkingBlocksInterleavedWithText() {
        let input = "<thinking>first</thinking>one<thinking>second</thinking>two"
        let chunks = parseInlineThinkingTags(input)
        XCTAssertEqual(chunks.count, 4)
        XCTAssertEqual(chunks[0], .thinking("first"))
        if case .text(let a) = chunks[1] {
            XCTAssertEqual(a.trimmingCharacters(in: .whitespacesAndNewlines), "one")
        } else {
            XCTFail("expected chunk[1] to be text")
        }
        XCTAssertEqual(chunks[2], .thinking("second"))
        if case .text(let b) = chunks[3] {
            XCTAssertEqual(b.trimmingCharacters(in: .whitespacesAndNewlines), "two")
        } else {
            XCTFail("expected chunk[3] to be text")
        }
    }

    func testWhitespaceOnlyTextBetweenTagsIsDropped() {
        // When the model's output is `</thinking>\n\n<thinking>` back to back,
        // the whitespace between the tags shouldn't produce an empty text
        // chunk that would waste a rendering slot.
        let input = "<thinking>a</thinking>\n\n<thinking>b</thinking>"
        let chunks = parseInlineThinkingTags(input)
        XCTAssertEqual(chunks, [.thinking("a"), .thinking("b")])
    }

    func testThinkingContentIsTrimmedButTextContentIsNot() {
        // Thinking content is trimmed so the collapsed block doesn't have
        // stray leading/trailing blank lines from tag positioning. Text
        // content preserves original whitespace so markdown spacing isn't
        // corrupted — it's up to the caller to trim when rendering.
        let input = "<thinking>\n  padded reasoning  \n</thinking>   some reply  "
        let chunks = parseInlineThinkingTags(input)
        XCTAssertEqual(chunks.count, 2)
        XCTAssertEqual(chunks[0], .thinking("padded reasoning"))
        if case .text(let body) = chunks[1] {
            XCTAssertEqual(body, "   some reply  ")
        } else {
            XCTFail("expected text chunk")
        }
    }

    func testContainsInlineThinkingTag() {
        XCTAssertFalse(containsInlineThinkingTag("plain text"))
        XCTAssertTrue(containsInlineThinkingTag("<thinking>foo</thinking>"))
        XCTAssertTrue(containsInlineThinkingTag("prelude <thinking>mid"))
        // Close tag alone (no open) does not count as inline thinking.
        XCTAssertFalse(containsInlineThinkingTag("</thinking> stray"))
    }
}
