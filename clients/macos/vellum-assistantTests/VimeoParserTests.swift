import XCTest
@testable import VellumAssistantLib

@MainActor
final class VimeoParserTests: XCTestCase {

    // MARK: - Standard URL

    func testStandardURL() {
        let url = URL(string: "https://vimeo.com/123456")!
        let result = VimeoParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "123456")
        XCTAssertEqual(result?.provider, "vimeo")
        XCTAssertEqual(result?.embedURL.absoluteString, "https://player.vimeo.com/video/123456")
    }

    // MARK: - WWW subdomain

    func testWWWSubdomain() {
        let url = URL(string: "https://www.vimeo.com/789012")!
        let result = VimeoParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "789012")
        XCTAssertEqual(result?.embedURL.absoluteString, "https://player.vimeo.com/video/789012")
    }

    // MARK: - Player embed URL

    func testPlayerEmbedURL() {
        let url = URL(string: "https://player.vimeo.com/video/456789")!
        let result = VimeoParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "456789")
        XCTAssertEqual(result?.embedURL.absoluteString, "https://player.vimeo.com/video/456789")
    }

    // MARK: - Channel URL

    func testChannelURL() {
        let url = URL(string: "https://vimeo.com/channels/staffpicks/123456")!
        let result = VimeoParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "123456")
        XCTAssertEqual(result?.embedURL.absoluteString, "https://player.vimeo.com/video/123456")
    }

    // MARK: - Group URL

    func testGroupURL() {
        let url = URL(string: "https://vimeo.com/groups/shortfilms/videos/987654")!
        let result = VimeoParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "987654")
        XCTAssertEqual(result?.embedURL.absoluteString, "https://player.vimeo.com/video/987654")
    }

    // MARK: - Non-Vimeo URL returns nil

    func testNonVimeoURLReturnsNil() {
        let url = URL(string: "https://www.youtube.com/watch?v=dQw4w9WgXcQ")!
        let result = VimeoParser.parse(url)
        XCTAssertNil(result)
    }

    func testRandomWebsiteReturnsNil() {
        let url = URL(string: "https://example.com/123456")!
        let result = VimeoParser.parse(url)
        XCTAssertNil(result)
    }

    // MARK: - HTTP URL returns nil (security)

    func testHTTPSchemeReturnsNil() {
        let url = URL(string: "http://vimeo.com/123456")!
        let result = VimeoParser.parse(url)
        XCTAssertNil(result)
    }

    // MARK: - Invalid / non-numeric video ID returns nil

    func testNonNumericVideoIDReturnsNil() {
        let url = URL(string: "https://vimeo.com/abcdef")!
        let result = VimeoParser.parse(url)
        XCTAssertNil(result)
    }

    func testAlphanumericVideoIDReturnsNil() {
        let url = URL(string: "https://vimeo.com/abc123")!
        let result = VimeoParser.parse(url)
        XCTAssertNil(result)
    }

    // MARK: - Vimeo homepage (no video ID) returns nil

    func testVimeoHomepageReturnsNil() {
        let url = URL(string: "https://vimeo.com/")!
        let result = VimeoParser.parse(url)
        XCTAssertNil(result)
    }

    func testVimeoHomepageNoTrailingSlashReturnsNil() {
        let url = URL(string: "https://vimeo.com")!
        let result = VimeoParser.parse(url)
        XCTAssertNil(result)
    }

    // MARK: - Provider is "vimeo"

    func testProviderIsVimeo() {
        let url = URL(string: "https://vimeo.com/111222")!
        let result = VimeoParser.parse(url)
        XCTAssertEqual(result?.provider, "vimeo")
    }

    // MARK: - Embed URL format is correct

    func testEmbedURLIsCanonicalForAllFormats() {
        let urls = [
            "https://vimeo.com/100200",
            "https://www.vimeo.com/100200",
            "https://player.vimeo.com/video/100200",
            "https://vimeo.com/channels/staffpicks/100200",
            "https://vimeo.com/groups/shortfilms/videos/100200",
        ]
        for urlString in urls {
            let result = VimeoParser.parse(URL(string: urlString)!)
            XCTAssertEqual(
                result?.embedURL.absoluteString,
                "https://player.vimeo.com/video/100200",
                "Canonical embed URL mismatch for input: \(urlString)"
            )
        }
    }

    // MARK: - Extra query parameters are handled

    func testURLWithQueryParameters() {
        let url = URL(string: "https://vimeo.com/123456?autoplay=1&color=ffffff")!
        let result = VimeoParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "123456")
        XCTAssertEqual(result?.embedURL.absoluteString, "https://player.vimeo.com/video/123456")
    }

    func testPlayerURLWithQueryParameters() {
        let url = URL(string: "https://player.vimeo.com/video/456789?title=0&byline=0")!
        let result = VimeoParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "456789")
        XCTAssertEqual(result?.embedURL.absoluteString, "https://player.vimeo.com/video/456789")
    }

    // MARK: - Player URL edge cases

    func testPlayerURLWithoutVideoPathReturnsNil() {
        let url = URL(string: "https://player.vimeo.com/123456")!
        let result = VimeoParser.parse(url)
        XCTAssertNil(result)
    }

    func testPlayerURLWithEmptyVideoIDReturnsNil() {
        let url = URL(string: "https://player.vimeo.com/video/")!
        let result = VimeoParser.parse(url)
        XCTAssertNil(result)
    }
}
