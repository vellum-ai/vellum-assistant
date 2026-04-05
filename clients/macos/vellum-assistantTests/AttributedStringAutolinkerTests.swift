import XCTest
@testable import VellumAssistantLib

/// Verifies that `AttributedStringAutolinker` attaches `.link` attributes to
/// bare URLs after markdown parsing, while leaving existing links and inline
/// code spans untouched.
final class AttributedStringAutolinkerTests: XCTestCase {

    // MARK: - Helpers

    /// Builds an `AttributedString` the same way the chat renderers do —
    /// with `.inlineOnlyPreservingWhitespace`, which does NOT autolink
    /// bare URLs.
    private func makeAttributed(_ source: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: source, options: options))
            ?? AttributedString(source)
    }

    /// Collects all distinct `.link` URLs and the substring they cover.
    private func extractLinks(from attributed: AttributedString) -> [(url: URL, text: String)] {
        var results: [(url: URL, text: String)] = []
        for run in attributed.runs {
            guard let link = run.link else { continue }
            let text = String(attributed[run.range].characters)
            results.append((url: link, text: text))
        }
        return results
    }

    // MARK: - Tests

    func testBareURLWithSchemeGetsLinked() {
        var attributed = makeAttributed("Visit https://example.com now")
        AttributedStringAutolinker.autolinkBareURLs(in: &attributed)

        let links = extractLinks(from: attributed)
        XCTAssertEqual(links.count, 1)
        XCTAssertEqual(links.first?.url.absoluteString, "https://example.com")
        XCTAssertEqual(links.first?.text, "https://example.com")
    }

    func testSchemelessURLGetsHTTPScheme() {
        var attributed = makeAttributed("See amazon.com/dp/B07978VPPH")
        AttributedStringAutolinker.autolinkBareURLs(in: &attributed)

        let links = extractLinks(from: attributed)
        XCTAssertEqual(links.count, 1)
        // NSDataDetector synthesizes http:// for schemeless URLs.
        XCTAssertEqual(links.first?.url.scheme, "http")
        XCTAssertEqual(links.first?.url.absoluteString, "http://amazon.com/dp/B07978VPPH")
    }

    func testExplicitMarkdownLinkIsPreserved() {
        // Markdown parser already sets .link on the bracketed text.
        var attributed = makeAttributed("[GitHub](https://github.com)")
        let before = extractLinks(from: attributed)
        XCTAssertEqual(before.count, 1)
        XCTAssertEqual(before.first?.url.absoluteString, "https://github.com")
        XCTAssertEqual(before.first?.text, "GitHub")

        AttributedStringAutolinker.autolinkBareURLs(in: &attributed)

        let after = extractLinks(from: attributed)
        XCTAssertEqual(after.count, 1, "autolinker must not touch existing links")
        XCTAssertEqual(after.first?.url.absoluteString, "https://github.com")
        XCTAssertEqual(after.first?.text, "GitHub")
    }

    func testURLInsideCodeSpanIsNotLinked() {
        var attributed = makeAttributed("Run `curl https://secret.com` in your shell")
        AttributedStringAutolinker.autolinkBareURLs(in: &attributed)

        let links = extractLinks(from: attributed)
        XCTAssertTrue(links.isEmpty, "code-span URLs must not be autolinked")
    }

    func testPlainTextWithoutURLsIsUnchanged() {
        var attributed = makeAttributed("Just some text with no links at all.")
        AttributedStringAutolinker.autolinkBareURLs(in: &attributed)

        let links = extractLinks(from: attributed)
        XCTAssertTrue(links.isEmpty)
    }

    func testMultipleURLsAreAllLinked() {
        var attributed = makeAttributed(
            "First https://a.example, then amazon.com/dp/X, and https://b.example/path"
        )
        AttributedStringAutolinker.autolinkBareURLs(in: &attributed)

        let links = extractLinks(from: attributed)
        XCTAssertEqual(links.count, 3)
        XCTAssertEqual(links[0].url.absoluteString, "https://a.example")
        XCTAssertEqual(links[1].url.absoluteString, "http://amazon.com/dp/X")
        XCTAssertEqual(links[2].url.absoluteString, "https://b.example/path")
    }

    func testEmptyAttributedStringIsNoOp() {
        var attributed = AttributedString("")
        AttributedStringAutolinker.autolinkBareURLs(in: &attributed)

        XCTAssertTrue(extractLinks(from: attributed).isEmpty)
    }

    func testBareURLInTableCellContext() {
        // Simulates a table cell: cell text is just the bare URL.
        var attributed = makeAttributed("amazon.com/dp/B07978VPPH")
        AttributedStringAutolinker.autolinkBareURLs(in: &attributed)

        let links = extractLinks(from: attributed)
        XCTAssertEqual(links.count, 1)
        XCTAssertEqual(links.first?.url.absoluteString, "http://amazon.com/dp/B07978VPPH")
        XCTAssertEqual(links.first?.text, "amazon.com/dp/B07978VPPH")
    }
}
