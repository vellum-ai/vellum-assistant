import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class YouTubeParserTests: XCTestCase {

    // MARK: - Standard watch URL

    func testStandardWatchURL() {
        let url = URL(string: "https://www.youtube.com/watch?v=dQw4w9WgXcQ")!
        let result = YouTubeParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "dQw4w9WgXcQ")
        XCTAssertEqual(result?.provider, "youtube")
        XCTAssertEqual(result?.embedURL.absoluteString, "https://www.youtube.com/embed/dQw4w9WgXcQ")
    }

    // MARK: - Short URL (youtu.be)

    func testShortURL() {
        let url = URL(string: "https://youtu.be/dQw4w9WgXcQ")!
        let result = YouTubeParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "dQw4w9WgXcQ")
        XCTAssertEqual(result?.embedURL.absoluteString, "https://www.youtube.com/embed/dQw4w9WgXcQ")
    }

    // MARK: - Shorts URL

    func testShortsURL() {
        let url = URL(string: "https://www.youtube.com/shorts/abc123XYZ_-")!
        let result = YouTubeParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "abc123XYZ_-")
        XCTAssertEqual(result?.embedURL.absoluteString, "https://www.youtube.com/embed/abc123XYZ_-")
    }

    // MARK: - Embed URL

    func testEmbedURL() {
        let url = URL(string: "https://www.youtube.com/embed/dQw4w9WgXcQ")!
        let result = YouTubeParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "dQw4w9WgXcQ")
        XCTAssertEqual(result?.embedURL.absoluteString, "https://www.youtube.com/embed/dQw4w9WgXcQ")
    }

    // MARK: - Mobile URL (m.youtube.com)

    func testMobileURL() {
        let url = URL(string: "https://m.youtube.com/watch?v=dQw4w9WgXcQ")!
        let result = YouTubeParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "dQw4w9WgXcQ")
        XCTAssertEqual(result?.embedURL.absoluteString, "https://www.youtube.com/embed/dQw4w9WgXcQ")
    }

    // MARK: - Extra query parameters

    func testWatchURLWithExtraQueryParams() {
        let url = URL(string: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf&index=2")!
        let result = YouTubeParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "dQw4w9WgXcQ")
        XCTAssertEqual(result?.embedURL.absoluteString, "https://www.youtube.com/embed/dQw4w9WgXcQ")
    }

    // MARK: - Timestamp parameter

    func testWatchURLWithTimestamp() {
        let url = URL(string: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120")!
        let result = YouTubeParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "dQw4w9WgXcQ")
    }

    func testShortURLWithTimestamp() {
        let url = URL(string: "https://youtu.be/dQw4w9WgXcQ?t=45")!
        let result = YouTubeParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "dQw4w9WgXcQ")
    }

    // MARK: - www vs no-www

    func testNoWWWSubdomain() {
        let url = URL(string: "https://youtube.com/watch?v=dQw4w9WgXcQ")!
        let result = YouTubeParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "dQw4w9WgXcQ")
    }

    func testWWWSubdomain() {
        let url = URL(string: "https://www.youtube.com/watch?v=dQw4w9WgXcQ")!
        let result = YouTubeParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "dQw4w9WgXcQ")
    }

    // MARK: - Non-YouTube URL returns nil

    func testNonYouTubeURLReturnsNil() {
        let url = URL(string: "https://vimeo.com/12345678")!
        let result = YouTubeParser.parse(url)
        XCTAssertNil(result)
    }

    func testRandomWebsiteReturnsNil() {
        let url = URL(string: "https://example.com/watch?v=abc123")!
        let result = YouTubeParser.parse(url)
        XCTAssertNil(result)
    }

    // MARK: - HTTP URL returns nil (security)

    func testHTTPSchemeReturnsNil() {
        let url = URL(string: "http://www.youtube.com/watch?v=dQw4w9WgXcQ")!
        let result = YouTubeParser.parse(url)
        XCTAssertNil(result)
    }

    func testHTTPShortURLReturnsNil() {
        let url = URL(string: "http://youtu.be/dQw4w9WgXcQ")!
        let result = YouTubeParser.parse(url)
        XCTAssertNil(result)
    }

    // MARK: - Malformed YouTube URL (no video ID)

    func testWatchURLWithoutVideoID() {
        let url = URL(string: "https://www.youtube.com/watch")!
        let result = YouTubeParser.parse(url)
        XCTAssertNil(result)
    }

    func testWatchURLWithEmptyVideoID() {
        let url = URL(string: "https://www.youtube.com/watch?v=")!
        let result = YouTubeParser.parse(url)
        XCTAssertNil(result)
    }

    func testShortsURLWithNoID() {
        let url = URL(string: "https://www.youtube.com/shorts/")!
        let result = YouTubeParser.parse(url)
        XCTAssertNil(result)
    }

    func testShortLinkWithNoPath() {
        let url = URL(string: "https://youtu.be/")!
        let result = YouTubeParser.parse(url)
        XCTAssertNil(result)
    }

    func testYouTubeHomepage() {
        let url = URL(string: "https://www.youtube.com/")!
        let result = YouTubeParser.parse(url)
        XCTAssertNil(result)
    }

    // MARK: - Video ID extraction accuracy

    func testVideoIDPreservesExactCharacters() {
        let url = URL(string: "https://www.youtube.com/watch?v=a1B2c3D4e5F")!
        let result = YouTubeParser.parse(url)
        XCTAssertEqual(result?.videoID, "a1B2c3D4e5F")
    }

    func testVideoIDWithHyphensAndUnderscores() {
        let url = URL(string: "https://www.youtube.com/watch?v=a-b_c-d_e-f")!
        let result = YouTubeParser.parse(url)
        XCTAssertEqual(result?.videoID, "a-b_c-d_e-f")
    }

    // MARK: - Embed URL is always canonical

    func testEmbedURLIsCanonicalForAllFormats() {
        let urls = [
            "https://www.youtube.com/watch?v=testID123",
            "https://youtu.be/testID123",
            "https://www.youtube.com/shorts/testID123",
            "https://www.youtube.com/embed/testID123",
            "https://m.youtube.com/watch?v=testID123",
            "https://youtube.com/watch?v=testID123",
        ]
        for urlString in urls {
            let result = YouTubeParser.parse(URL(string: urlString)!)
            XCTAssertEqual(
                result?.embedURL.absoluteString,
                "https://www.youtube.com/embed/testID123",
                "Canonical embed URL mismatch for input: \(urlString)"
            )
        }
    }

    // MARK: - Unrelated YouTube paths return nil

    func testYouTubeChannelReturnsNil() {
        let url = URL(string: "https://www.youtube.com/c/SomeChannel")!
        let result = YouTubeParser.parse(url)
        XCTAssertNil(result)
    }

    func testYouTubePlaylistReturnsNil() {
        let url = URL(string: "https://www.youtube.com/playlist?list=PLrAXtmErZgOe")!
        let result = YouTubeParser.parse(url)
        XCTAssertNil(result)
    }

    // MARK: - No-www shorts and embed

    func testShortsWithoutWWW() {
        let url = URL(string: "https://youtube.com/shorts/abc123")!
        let result = YouTubeParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "abc123")
    }

    func testEmbedWithoutWWW() {
        let url = URL(string: "https://youtube.com/embed/abc123")!
        let result = YouTubeParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "abc123")
    }
}
