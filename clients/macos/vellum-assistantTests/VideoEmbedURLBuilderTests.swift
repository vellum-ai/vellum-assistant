import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class VideoEmbedURLBuilderTests: XCTestCase {

    // MARK: - YouTube

    func testYouTubeEmbedURLFormat() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "youtube", videoID: "dQw4w9WgXcQ")
        XCTAssertNotNil(url)
        XCTAssertEqual(
            url?.absoluteString,
            "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&playsinline=1"
        )
    }

    func testYouTubeEmbedURLHasAutoplayAndRel() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "youtube", videoID: "abc123")!
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let queryItems = components.queryItems ?? []

        XCTAssertTrue(queryItems.contains(where: { $0.name == "autoplay" && $0.value == "1" }))
        XCTAssertTrue(queryItems.contains(where: { $0.name == "rel" && $0.value == "0" }))
        XCTAssertTrue(queryItems.contains(where: { $0.name == "playsinline" && $0.value == "1" }))
    }

    // MARK: - Vimeo

    func testVimeoEmbedURLFormat() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "vimeo", videoID: "76979871")
        XCTAssertNotNil(url)
        XCTAssertEqual(
            url?.absoluteString,
            "https://player.vimeo.com/video/76979871?autoplay=1"
        )
    }

    func testVimeoEmbedURLHasAutoplay() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "vimeo", videoID: "76979871")!
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let queryItems = components.queryItems ?? []

        XCTAssertTrue(queryItems.contains(where: { $0.name == "autoplay" && $0.value == "1" }))
    }

    // MARK: - Loom

    func testLoomEmbedURLFormat() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "loom", videoID: "abc123def456")
        XCTAssertNotNil(url)
        XCTAssertEqual(
            url?.absoluteString,
            "https://www.loom.com/embed/abc123def456?autoplay=1"
        )
    }

    func testLoomEmbedURLHasAutoplay() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "loom", videoID: "abc123def456")!
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let queryItems = components.queryItems ?? []

        XCTAssertTrue(queryItems.contains(where: { $0.name == "autoplay" && $0.value == "1" }))
    }

    // MARK: - Unknown provider

    func testUnknownProviderReturnsNil() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "dailymotion", videoID: "x12345")
        XCTAssertNil(url)
    }

    // MARK: - Case insensitivity

    func testUppercaseProviderName() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "YOUTUBE", videoID: "testID")
        XCTAssertNotNil(url)
        XCTAssertEqual(
            url?.absoluteString,
            "https://www.youtube.com/embed/testID?autoplay=1&rel=0&playsinline=1"
        )
    }

    func testMixedCaseProviderName() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "YouTube", videoID: "testID")
        XCTAssertNotNil(url)
        XCTAssertEqual(
            url?.absoluteString,
            "https://www.youtube.com/embed/testID?autoplay=1&rel=0&playsinline=1"
        )
    }

    // MARK: - Special characters in video ID

    func testVideoIDWithHyphensAndUnderscores() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "youtube", videoID: "a-b_c-d_e")
        XCTAssertNotNil(url)
        XCTAssertTrue(url!.absoluteString.contains("a-b_c-d_e"))
    }

    // MARK: - Empty video ID

    func testEmptyVideoIDStillProducesURL() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "youtube", videoID: "")
        // Should not crash; URL(string:) can still produce a valid URL
        XCTAssertNotNil(url)
    }

    // MARK: - No mute parameter (unmuted defaults for v1)

    func testYouTubeDoesNotIncludeMuteParameter() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "youtube", videoID: "abc")!
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let queryItems = components.queryItems ?? []

        XCTAssertFalse(queryItems.contains(where: { $0.name == "mute" }))
    }

    func testVimeoDoesNotIncludeMutedParameter() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "vimeo", videoID: "123")!
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let queryItems = components.queryItems ?? []

        XCTAssertFalse(queryItems.contains(where: { $0.name == "muted" }))
    }

    func testLoomDoesNotIncludeMuteParameter() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "loom", videoID: "xyz")!
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let queryItems = components.queryItems ?? []

        XCTAssertFalse(queryItems.contains(where: { $0.name == "mute" }))
    }
}
