import XCTest
@testable import VellumAssistantLib

@MainActor
final class MessageURLExtractorCodeExclusionTests: XCTestCase {

    // MARK: - Inline code spans

    func testURLInsideInlineCodeIsNotExtracted() {
        let text = "Run `curl https://example.com/api` to test"
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertTrue(urls.isEmpty)
    }

    func testURLOutsideInlineCodeIsExtracted() {
        let text = "Visit https://example.com and run `echo hello`"
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com")
    }

    func testMixedInlineCodeAndPlainURL() {
        let text = "See `https://code.example.com` and also https://real.example.com for info"
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://real.example.com")
    }

    // MARK: - Fenced code blocks

    func testURLInsideFencedCodeBlockIsNotExtracted() {
        let text = """
        Here is an example:
        ```
        curl https://api.example.com/v1/data
        ```
        """
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertTrue(urls.isEmpty)
    }

    func testURLInsideFencedCodeBlockWithLanguageIsNotExtracted() {
        let text = """
        ```bash
        wget https://downloads.example.com/file.tar.gz
        ```
        """
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertTrue(urls.isEmpty)
    }

    func testMultiLineCodeBlockWithMultipleURLsNotExtracted() {
        let text = """
        ```python
        import requests
        r1 = requests.get("https://api.example.com/users")
        r2 = requests.get("https://api.example.com/posts")
        print(r1.json())
        ```
        """
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertTrue(urls.isEmpty)
    }

    func testURLOutsideFencedCodeBlockIsExtracted() {
        let text = """
        Check https://docs.example.com for usage.
        ```
        # this is just a code sample
        echo "hello"
        ```
        """
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://docs.example.com")
    }

    // MARK: - Mixed scenarios

    func testURLInCodeAndURLInTextOnlyTextExtracted() {
        let text = """
        Visit https://real.example.com for details.
        ```
        curl https://fake.example.com/api
        ```
        Also check `https://also-fake.example.com` in code.
        """
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://real.example.com")
    }

    func testMultipleCodeBlocksWithURLsBetween() {
        let text = """
        ```
        https://block1.example.com
        ```
        Real link: https://middle.example.com
        ```
        https://block2.example.com
        ```
        """
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://middle.example.com")
    }

    // MARK: - Nested backticks

    func testCodeBlockContainingBacktickCharacters() {
        let text = """
        ```
        echo `https://nested.example.com`
        ```
        """
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertTrue(urls.isEmpty)
    }

    // MARK: - Markdown links inside code

    func testMarkdownLinkInsideInlineCodeNotExtracted() {
        let text = "Use `[link](https://example.com)` syntax for links"
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertTrue(urls.isEmpty)
    }

    func testMarkdownLinkInsideFencedBlockNotExtracted() {
        let text = """
        ```markdown
        [Click here](https://example.com/page)
        ```
        """
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertTrue(urls.isEmpty)
    }

    // MARK: - Edge cases

    func testEmptyCodeSpanDoesNotAffectExtraction() {
        let text = "See `` and https://example.com"
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com")
    }

    func testNoCodeRegionsExtractsNormally() {
        let text = "Visit https://example.com and https://other.com"
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertEqual(urls.count, 2)
        XCTAssertEqual(urls[0].absoluteString, "https://example.com")
        XCTAssertEqual(urls[1].absoluteString, "https://other.com")
    }

    func testStripCodeRegionsDirectly() {
        let text = "Hello `code here` world"
        let stripped = MessageURLExtractor.stripCodeRegions(from: text)
        XCTAssertEqual(stripped, "Hello   world")
    }

    func testStripFencedCodeRegionsDirectly() {
        let text = """
        Before
        ```
        inside fence
        ```
        After
        """
        let stripped = MessageURLExtractor.stripCodeRegions(from: text)
        XCTAssertTrue(stripped.contains("Before"))
        XCTAssertTrue(stripped.contains("After"))
        XCTAssertFalse(stripped.contains("inside fence"))
    }

    // MARK: - Space placeholder prevents URL concatenation

    func testInlineCodeStrippingPreservesSpaceSeparator() {
        // Stripping code regions uses a space placeholder to prevent
        // surrounding text from concatenating into spurious tokens.
        let stripped = MessageURLExtractor.stripCodeRegions(from: "prefix`code`suffix")
        XCTAssertEqual(stripped, "prefix suffix")
        XCTAssertFalse(stripped.contains("prefixsuffix"),
                       "Code stripping must not concatenate adjacent text")
    }

    func testSpacePlaceholderPreservesTokenBoundaries() {
        let stripped = MessageURLExtractor.stripCodeRegions(from: "a`code`b")
        // Should be "a b" (space between), not "ab".
        XCTAssertEqual(stripped, "a b")
    }

    // MARK: - Unterminated fenced code blocks

    func testURLInsideUnterminatedFencedBlockIsNotExtracted() {
        let text = """
        Here is some text
        ```
        curl https://api.example.com/streaming
        more code here
        """
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertTrue(urls.isEmpty, "URLs inside unterminated fenced blocks should be excluded")
    }

    func testURLBeforeUnterminatedFenceIsExtracted() {
        let text = """
        Visit https://real.example.com first.
        ```python
        requests.get("https://fake.example.com")
        """
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://real.example.com")
    }

    func testUnterminatedFenceStripsToEndOfString() {
        let text = """
        Before
        ```
        inside unterminated fence
        still inside
        """
        let stripped = MessageURLExtractor.stripCodeRegions(from: text)
        XCTAssertTrue(stripped.contains("Before"))
        XCTAssertFalse(stripped.contains("inside unterminated fence"))
        XCTAssertFalse(stripped.contains("still inside"))
    }

    func testTerminatedFenceStillWorksNormally() {
        // Ensure the regex change didn't break normal fenced blocks.
        let text = """
        ```
        https://inside.example.com
        ```
        https://outside.example.com
        """
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://outside.example.com")
    }
}
