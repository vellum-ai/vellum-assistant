import XCTest
@testable import VellumAssistantLib

@MainActor
final class LoomParserTests: XCTestCase {

    // MARK: - Standard share URL

    func testStandardShareURL() {
        let url = URL(string: "https://loom.com/share/abc123def456789012345678abcdef90")!
        let result = LoomParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "abc123def456789012345678abcdef90")
    }

    func testWWWShareURL() {
        let url = URL(string: "https://www.loom.com/share/abc123def456789012345678abcdef90")!
        let result = LoomParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "abc123def456789012345678abcdef90")
    }

    // MARK: - Embed URL

    func testEmbedURL() {
        let url = URL(string: "https://loom.com/embed/abc123def456789012345678abcdef90")!
        let result = LoomParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "abc123def456789012345678abcdef90")
    }

    func testWWWEmbedURL() {
        let url = URL(string: "https://www.loom.com/embed/abc123def456789012345678abcdef90")!
        let result = LoomParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "abc123def456789012345678abcdef90")
    }

    // MARK: - Non-Loom URL returns nil

    func testNonLoomURLReturnsNil() {
        let url = URL(string: "https://youtube.com/watch?v=dQw4w9WgXcQ")!
        let result = LoomParser.parse(url)
        XCTAssertNil(result)
    }

    func testRandomWebsiteReturnsNil() {
        let url = URL(string: "https://example.com/share/abc123")!
        let result = LoomParser.parse(url)
        XCTAssertNil(result)
    }

    // MARK: - HTTP URL returns nil (security)

    func testHTTPSchemeReturnsNil() {
        let url = URL(string: "http://www.loom.com/share/abc123def456789012345678abcdef90")!
        let result = LoomParser.parse(url)
        XCTAssertNil(result)
    }

    // MARK: - Loom homepage (no video ID) returns nil

    func testLoomHomepageReturnsNil() {
        let url = URL(string: "https://www.loom.com/")!
        let result = LoomParser.parse(url)
        XCTAssertNil(result)
    }

    func testLoomShareWithNoID() {
        let url = URL(string: "https://www.loom.com/share/")!
        let result = LoomParser.parse(url)
        XCTAssertNil(result)
    }

    // MARK: - Provider is "loom"

    func testProviderIsLoom() {
        let url = URL(string: "https://www.loom.com/share/abc123def456")!
        let result = LoomParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.provider, "loom")
    }

    // MARK: - Embed URL format is correct (always uses /embed/)

    func testEmbedURLFormatIsCorrect() {
        let url = URL(string: "https://www.loom.com/embed/abc123def456")!
        let result = LoomParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.embedURL.absoluteString, "https://www.loom.com/embed/abc123def456")
    }

    // MARK: - Share URL converts to embed URL

    func testShareURLConvertsToEmbedURL() {
        let url = URL(string: "https://www.loom.com/share/abc123def456")!
        let result = LoomParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.embedURL.absoluteString, "https://www.loom.com/embed/abc123def456")
    }

    func testShareURLWithoutWWWConvertsToEmbedWithWWW() {
        let url = URL(string: "https://loom.com/share/abc123def456")!
        let result = LoomParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.embedURL.absoluteString, "https://www.loom.com/embed/abc123def456")
    }

    // MARK: - Query parameters

    func testShareURLWithQueryParameters() {
        let url = URL(string: "https://www.loom.com/share/abc123def456?sid=xyz&t=10")!
        let result = LoomParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "abc123def456")
        XCTAssertEqual(result?.embedURL.absoluteString, "https://www.loom.com/embed/abc123def456")
    }

    // MARK: - Invalid path (no share/embed prefix) returns nil

    func testInvalidPathReturnsNil() {
        let url = URL(string: "https://www.loom.com/watch/abc123def456")!
        let result = LoomParser.parse(url)
        XCTAssertNil(result)
    }

    func testLoomMyVideosReturnsNil() {
        let url = URL(string: "https://www.loom.com/my-videos")!
        let result = LoomParser.parse(url)
        XCTAssertNil(result)
    }

    // MARK: - Embed URL is canonical for all input formats

    func testEmbedURLIsCanonicalForAllFormats() {
        let urls = [
            "https://www.loom.com/share/testID123",
            "https://loom.com/share/testID123",
            "https://www.loom.com/embed/testID123",
            "https://loom.com/embed/testID123",
        ]
        for urlString in urls {
            let result = LoomParser.parse(URL(string: urlString)!)
            XCTAssertEqual(
                result?.embedURL.absoluteString,
                "https://www.loom.com/embed/testID123",
                "Canonical embed URL mismatch for input: \(urlString)"
            )
        }
    }
}
