import XCTest
@testable import VellumAssistantShared

final class MediaEmbedResolverTests: XCTestCase {

    // MARK: - YouTubeParser

    func testYouTubeWatchURL() {
        let url = URL(string: "https://www.youtube.com/watch?v=dQw4w9WgXcQ")!
        let result = YouTubeParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "dQw4w9WgXcQ")
        XCTAssertEqual(result?.provider, "youtube")
        XCTAssertEqual(result?.embedURL.absoluteString, "https://www.youtube.com/embed/dQw4w9WgXcQ")
    }

    func testYouTubeShortLink() {
        let url = URL(string: "https://youtu.be/dQw4w9WgXcQ")!
        let result = YouTubeParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "dQw4w9WgXcQ")
    }

    func testYouTubeShortsURL() {
        let url = URL(string: "https://www.youtube.com/shorts/abc123")!
        let result = YouTubeParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "abc123")
    }

    func testYouTubeEmbedURL() {
        let url = URL(string: "https://www.youtube.com/embed/abc123")!
        let result = YouTubeParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "abc123")
    }

    func testYouTubeRejectsHTTP() {
        let url = URL(string: "http://www.youtube.com/watch?v=abc123")!
        XCTAssertNil(YouTubeParser.parse(url))
    }

    func testYouTubeRejectsNonYouTube() {
        let url = URL(string: "https://www.example.com/watch?v=abc123")!
        XCTAssertNil(YouTubeParser.parse(url))
    }

    func testYouTubeMobileSubdomain() {
        let url = URL(string: "https://m.youtube.com/watch?v=xyz789")!
        let result = YouTubeParser.parse(url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.videoID, "xyz789")
    }

    // MARK: - VideoEmbedURLBuilder

    func testYouTubeEmbedBuilderAddsPlaysinline() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "youtube", videoID: "abc123")
        let components = URLComponents(url: url!, resolvingAgainstBaseURL: false)
        let queryItems = components?.queryItems ?? []

        XCTAssertTrue(queryItems.contains(where: { $0.name == "playsinline" && $0.value == "1" }))
    }

    // MARK: - VideoEmbedRequestBuilder

    func testYouTubeEmbedRequestAddsRefererHeader() {
        let request = VideoEmbedRequestBuilder.buildRequest(
            url: URL(string: "https://www.youtube.com/embed/abc123")!,
            provider: "youtube"
        )

        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Referer"),
            VideoEmbedRequestBuilder.defaultReferer
        )
    }

    func testNonYouTubeEmbedRequestOmitsRefererHeader() {
        let request = VideoEmbedRequestBuilder.buildRequest(
            url: URL(string: "https://player.vimeo.com/video/123")!,
            provider: "vimeo"
        )

        XCTAssertNil(request.value(forHTTPHeaderField: "Referer"))
    }

    // MARK: - DomainAllowlistMatcher

    func testExactDomainMatch() {
        let url = URL(string: "https://youtube.com/watch?v=abc")!
        XCTAssertTrue(DomainAllowlistMatcher.isAllowed(url, allowedDomains: ["youtube.com"]))
    }

    func testSubdomainMatch() {
        let url = URL(string: "https://www.youtube.com/watch?v=abc")!
        XCTAssertTrue(DomainAllowlistMatcher.isAllowed(url, allowedDomains: ["youtube.com"]))
    }

    func testNoMatch() {
        let url = URL(string: "https://evil.com/watch?v=abc")!
        XCTAssertFalse(DomainAllowlistMatcher.isAllowed(url, allowedDomains: ["youtube.com"]))
    }

    func testRejectsHTTP() {
        let url = URL(string: "http://youtube.com/watch?v=abc")!
        XCTAssertFalse(DomainAllowlistMatcher.isAllowed(url, allowedDomains: ["youtube.com"]))
    }

    func testEmptyAllowlist() {
        let url = URL(string: "https://youtube.com/watch?v=abc")!
        XCTAssertFalse(DomainAllowlistMatcher.isAllowed(url, allowedDomains: []))
    }

    // MARK: - ImageURLClassifier

    func testClassifiesImageExtensions() {
        for ext in ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic"] {
            let url = URL(string: "https://example.com/photo.\(ext)")!
            XCTAssertEqual(ImageURLClassifier.classify(url), .image, "Expected \(ext) to be classified as image")
        }
    }

    func testClassifiesNonImageExtension() {
        let url = URL(string: "https://example.com/document.pdf")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .notImage)
    }

    func testClassifiesUnknownForExtensionless() {
        let url = URL(string: "https://example.com/photo")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .unknown)
    }

    func testRejectsHTTPImage() {
        let url = URL(string: "http://example.com/photo.png")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .notImage)
    }

    // MARK: - MessageURLExtractor

    func testExtractsPlainURL() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "Check out https://example.com/page today")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com/page")
    }

    func testExtractsMarkdownLinkURL() {
        let urls = MessageURLExtractor.extractMarkdownLinkURLs(from: "Visit [Example](https://example.com)")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com")
    }

    func testStripsCodeRegions() {
        let text = "Before `https://code.example.com` after"
        let stripped = MessageURLExtractor.stripCodeRegions(from: text)
        XCTAssertFalse(stripped.contains("code.example.com"))
    }

    func testStripsFencedCodeBlocks() {
        let text = """
        Before
        ```
        https://code.example.com
        ```
        After https://outside.example.com
        """
        let stripped = MessageURLExtractor.stripCodeRegions(from: text)
        XCTAssertFalse(stripped.contains("code.example.com"))
    }

    func testExtractAllURLsDeduplicates() {
        let text = "Visit https://example.com and [link](https://example.com)"
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertEqual(urls.count, 1)
    }

    func testExtractAllURLsExcludesCodeBlocks() {
        let text = """
        Real: https://real.example.com
        ```
        Fake: https://fake.example.com
        ```
        """
        let urls = MessageURLExtractor.extractAllURLs(from: text)
        XCTAssertTrue(urls.contains(where: { $0.host == "real.example.com" }))
        XCTAssertFalse(urls.contains(where: { $0.host == "fake.example.com" }))
    }

    // MARK: - InlineVideoEmbedState

    @MainActor
    func testStateTransitions() {
        let manager = InlineVideoEmbedStateManager()
        XCTAssertEqual(manager.state, .placeholder)

        manager.requestPlay()
        XCTAssertEqual(manager.state, .initializing)

        manager.didStartPlaying()
        XCTAssertEqual(manager.state, .playing)

        manager.reset()
        XCTAssertEqual(manager.state, .placeholder)
    }

    @MainActor
    func testRequestPlayFromFailed() {
        let manager = InlineVideoEmbedStateManager()
        manager.requestPlay()
        manager.didFail("error")
        XCTAssertEqual(manager.state, .failed("error"))

        manager.requestPlay()
        XCTAssertEqual(manager.state, .initializing)
    }

    @MainActor
    func testRequestPlayIgnoredWhenPlaying() {
        let manager = InlineVideoEmbedStateManager()
        manager.requestPlay()
        manager.didStartPlaying()
        XCTAssertEqual(manager.state, .playing)

        // Tapping play again should be no-op
        manager.requestPlay()
        XCTAssertEqual(manager.state, .playing)
    }
}
