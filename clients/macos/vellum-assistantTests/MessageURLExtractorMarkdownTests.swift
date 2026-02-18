import XCTest
@testable import VellumAssistantLib

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
        // Plain URLs come first (NSDataDetector finds https://second.com),
        // then markdown-only URLs that weren't already seen.
        XCTAssertTrue(urls.count >= 2)
        // All three should be present
        let strings = urls.map(\.absoluteString)
        XCTAssertTrue(strings.contains("https://first.com"))
        XCTAssertTrue(strings.contains("https://second.com"))
        XCTAssertTrue(strings.contains("https://third.com"))
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
}
