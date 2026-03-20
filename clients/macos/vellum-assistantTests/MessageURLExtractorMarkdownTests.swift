import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MessageURLExtractorMarkdownTests: XCTestCase {

    // MARK: - Single markdown link

    func testSingleMarkdownLink() {
        let urls = MessageURLExtractor.extractMarkdownLinkURLs(
            from: "Check out [Example](https://example.com) for more"
        )
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com")
    }

    // MARK: - Multiple markdown links

    func testMultipleMarkdownLinks() {
        let text = "See [Alpha](https://alpha.com) and [Beta](https://beta.com) and [Gamma](https://gamma.com)"
        let urls = MessageURLExtractor.extractMarkdownLinkURLs(from: text)
        XCTAssertEqual(urls.count, 3)
        XCTAssertEqual(urls[0].absoluteString, "https://alpha.com")
        XCTAssertEqual(urls[1].absoluteString, "https://beta.com")
        XCTAssertEqual(urls[2].absoluteString, "https://gamma.com")
    }

    // MARK: - Mixed plain and markdown (extractAllURLs)

    func testMixedPlainAndMarkdownURLs() {
        let text = "Visit https://plain.com and [Markdown](https://markdown.com)"
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertEqual(urls.count, 2)
        XCTAssertEqual(urls[0].absoluteString, "https://plain.com")
        XCTAssertEqual(urls[1].absoluteString, "https://markdown.com")
    }

    // MARK: - Deduplication across plain and markdown

    func testMarkdownURLAlreadyPresentAsPlainTextIsDeduplicated() {
        let text = "See https://example.com and [Example](https://example.com)"
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com")
    }

    func testDuplicateMarkdownLinksReturnedOnce() {
        let text = "[A](https://example.com) and [B](https://example.com)"
        let urls = MessageURLExtractor.extractMarkdownLinkURLs(from: text)
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com")
    }

    // MARK: - Nested brackets

    func testNestedBracketsInLinkText() {
        let text = "Check [[nested]](https://example.com/nested) out"
        let urls = MessageURLExtractor.extractMarkdownLinkURLs(from: text)
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com/nested")
    }

    // MARK: - No markdown links

    func testNoMarkdownLinksReturnsEmpty() {
        let urls = MessageURLExtractor.extractMarkdownLinkURLs(
            from: "Just some plain text with no links at all."
        )
        XCTAssertTrue(urls.isEmpty)
    }

    func testEmptyStringReturnsEmpty() {
        let urls = MessageURLExtractor.extractMarkdownLinkURLs(from: "")
        XCTAssertTrue(urls.isEmpty)
    }

    // MARK: - Markdown links with titles

    func testMarkdownLinkWithTitle() {
        let text = #"Click [here](https://example.com/page "Example Page") to visit"#
        let urls = MessageURLExtractor.extractMarkdownLinkURLs(from: text)
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com/page")
    }

    // MARK: - Non-HTTP schemes excluded

    func testFTPMarkdownLinkIsExcluded() {
        let urls = MessageURLExtractor.extractMarkdownLinkURLs(
            from: "[Download](ftp://files.example.com/data.zip)"
        )
        XCTAssertTrue(urls.isEmpty)
    }

    func testMailtoMarkdownLinkIsExcluded() {
        let urls = MessageURLExtractor.extractMarkdownLinkURLs(
            from: "[Email](mailto:user@example.com)"
        )
        XCTAssertTrue(urls.isEmpty)
    }

    // MARK: - URLs with paths, queries, fragments

    func testMarkdownLinkWithPath() {
        let urls = MessageURLExtractor.extractMarkdownLinkURLs(
            from: "[Docs](https://example.com/docs/api/v2)"
        )
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com/docs/api/v2")
    }

    func testMarkdownLinkWithQueryString() {
        let urls = MessageURLExtractor.extractMarkdownLinkURLs(
            from: "[Search](https://example.com/search?q=swift&page=2)"
        )
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com/search?q=swift&page=2")
    }

    func testMarkdownLinkWithFragment() {
        let urls = MessageURLExtractor.extractMarkdownLinkURLs(
            from: "[Section](https://example.com/docs#section-3)"
        )
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com/docs#section-3")
    }

    // MARK: - extractAllURLs ordering

    func testExtractAllURLsPreservesFirstOccurrenceOrder() {
        let text = "[MD First](https://first.com) then https://second.com and [MD Third](https://third.com)"
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        let strings = urls.map(\.absoluteString)
        // All three should be present in their original text order.
        XCTAssertEqual(strings, [
            "https://first.com",
            "https://second.com",
            "https://third.com",
        ])
    }

    func testExtractAllURLsWithOnlyMarkdown() {
        let text = "See [Example](https://example.com)"
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        // NSDataDetector may or may not pick up the URL inside markdown
        // syntax, but extractAllURLs must include it at least once.
        let strings = urls.map(\.absoluteString)
        XCTAssertTrue(strings.contains("https://example.com"))
        // No duplicates
        XCTAssertEqual(urls.count, Set(strings).count)
    }

    // MARK: - Parentheses in URL (e.g. Wikipedia)

    func testMarkdownLinkWithParenthesesInURL() {
        let urls = MessageURLExtractor.extractMarkdownLinkURLs(
            from: "[Wiki](https://en.wikipedia.org/wiki/Swift_(programming_language))"
        )
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(
            urls.first?.absoluteString,
            "https://en.wikipedia.org/wiki/Swift_(programming_language)"
        )
    }

    func testMarkdownLinkWithDoubleNestedParentheses() {
        let urls = MessageURLExtractor.extractMarkdownLinkURLs(
            from: "[x](https://example.com/foo_(bar_(baz)))"
        )
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(
            urls.first?.absoluteString,
            "https://example.com/foo_(bar_(baz))"
        )
    }

    func testMarkdownLinkWithMultipleParenGroups() {
        let urls = MessageURLExtractor.extractMarkdownLinkURLs(
            from: "[x](https://example.com/a_(b)_c_(d))"
        )
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(
            urls.first?.absoluteString,
            "https://example.com/a_(b)_c_(d)"
        )
    }

    // MARK: - Global first-occurrence ordering

    func testExtractAllURLsPreservesGlobalOrder_MarkdownBeforePlain() {
        // Markdown link appears first in text, plain URL second.
        let text = "[First](https://first.com) then https://second.com"
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertEqual(urls.count, 2)
        XCTAssertEqual(urls[0].absoluteString, "https://first.com")
        XCTAssertEqual(urls[1].absoluteString, "https://second.com")
    }

    func testExtractAllURLsPreservesGlobalOrder_Interleaved() {
        // Pattern: markdown, plain, markdown — should come out in that order.
        let text = "[A](https://a.com) then https://b.com then [C](https://c.com)"
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertEqual(urls.count, 3)
        XCTAssertEqual(urls[0].absoluteString, "https://a.com")
        XCTAssertEqual(urls[1].absoluteString, "https://b.com")
        XCTAssertEqual(urls[2].absoluteString, "https://c.com")
    }

    func testExtractAllURLsPreservesGlobalOrder_WithEmoji() {
        // Emoji are 1 Character but 2+ UTF-16 code units — positions must
        // use the same coordinate space or the sort will be wrong.
        let text = "🎉 [A](https://a.com) then https://b.com"
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertEqual(urls.count, 2)
        XCTAssertEqual(urls[0].absoluteString, "https://a.com")
        XCTAssertEqual(urls[1].absoluteString, "https://b.com")
    }

    // MARK: - Catastrophic backtracking regression

    func testLongURLWithUnbalancedParensDoesNotHang() {
        // A long URL-like string with an unbalanced opening paren triggers
        // exponential backtracking in the `(a+)+` pattern if the regex
        // lacks possessive quantifiers. This must complete in < 1 second.
        let longPath = String(repeating: "a", count: 200)
        let text = "[link](https://example.com/\(longPath)(broken"
        let start = CFAbsoluteTimeGetCurrent()
        let urls = MessageURLExtractor.extractMarkdownLinkURLs(from: text)
        let elapsed = CFAbsoluteTimeGetCurrent() - start
        XCTAssertTrue(urls.isEmpty)
        XCTAssertLessThan(elapsed, 1.0, "Regex took \(elapsed)s — possible catastrophic backtracking")
    }
}
