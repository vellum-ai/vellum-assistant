import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class InlineVideoPlayerIntegrationTests: XCTestCase {

    // MARK: - VideoEmbedURLBuilder correctness

    func testYouTubeBuilderReturnsAutoplayURL() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "youtube", videoID: "dQw4w9WgXcQ")
        XCTAssertNotNil(url)
        XCTAssertEqual(
            url?.absoluteString,
            "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&playsinline=1"
        )
    }

    func testVimeoBuilderReturnsAutoplayURL() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "vimeo", videoID: "76979871")
        XCTAssertNotNil(url)
        XCTAssertEqual(
            url?.absoluteString,
            "https://player.vimeo.com/video/76979871?autoplay=1"
        )
    }

    func testLoomBuilderReturnsAutoplayURL() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "loom", videoID: "abc123def456")
        XCTAssertNotNil(url)
        XCTAssertEqual(
            url?.absoluteString,
            "https://www.loom.com/embed/abc123def456?autoplay=1"
        )
    }

    func testUnknownProviderBuilderReturnsNil() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "unknown", videoID: "xyz")
        XCTAssertNil(url)
    }

    // MARK: - State manager end-to-end transitions

    func testStateManagerPlaceholderToPlayingTransition() {
        let manager = InlineVideoEmbedStateManager()
        XCTAssertEqual(manager.state, .placeholder)

        manager.requestPlay()
        XCTAssertEqual(manager.state, .initializing)

        manager.didStartPlaying()
        XCTAssertEqual(manager.state, .playing)
    }

    func testStateManagerFailAndRetryTransition() {
        let manager = InlineVideoEmbedStateManager()

        manager.requestPlay()
        manager.didFail("Network error")
        XCTAssertEqual(manager.state, .failed("Network error"))

        // Retry should go back to initializing
        manager.requestPlay()
        XCTAssertEqual(manager.state, .initializing)

        manager.didStartPlaying()
        XCTAssertEqual(manager.state, .playing)
    }

    func testStateManagerResetFromPlaying() {
        let manager = InlineVideoEmbedStateManager()

        manager.requestPlay()
        manager.didStartPlaying()
        XCTAssertEqual(manager.state, .playing)

        manager.reset()
        XCTAssertEqual(manager.state, .placeholder)
    }

    func testStateManagerDoublePlayIsNoOp() {
        let manager = InlineVideoEmbedStateManager()

        manager.requestPlay()
        manager.didStartPlaying()
        XCTAssertEqual(manager.state, .playing)

        // Second requestPlay while already playing should be ignored
        manager.requestPlay()
        XCTAssertEqual(manager.state, .playing)
    }

    // MARK: - InlineVideoEmbedCard instantiation

    func testCardCanBeInstantiatedWithYouTube() {
        let url = URL(string: "https://www.youtube.com/embed/dQw4w9WgXcQ")!
        let card = InlineVideoEmbedCard(
            provider: "youtube",
            videoID: "dQw4w9WgXcQ",
            embedURL: url
        )

        XCTAssertEqual(card.provider, "youtube")
        XCTAssertEqual(card.videoID, "dQw4w9WgXcQ")
        XCTAssertEqual(card.embedURL, url)
    }

    func testCardCanBeInstantiatedWithVimeo() {
        let url = URL(string: "https://player.vimeo.com/video/76979871")!
        let card = InlineVideoEmbedCard(
            provider: "vimeo",
            videoID: "76979871",
            embedURL: url
        )

        XCTAssertEqual(card.provider, "vimeo")
        XCTAssertEqual(card.videoID, "76979871")
        XCTAssertEqual(card.embedURL, url)
    }

    func testCardCanBeInstantiatedWithLoom() {
        let url = URL(string: "https://www.loom.com/embed/abc123def456")!
        let card = InlineVideoEmbedCard(
            provider: "loom",
            videoID: "abc123def456",
            embedURL: url
        )

        XCTAssertEqual(card.provider, "loom")
        XCTAssertEqual(card.videoID, "abc123def456")
        XCTAssertEqual(card.embedURL, url)
    }

    // MARK: - Builder + Card integration

    func testBuilderURLMatchesExpectedFormatForCard() {
        // Verify the URL the card would use for playback matches what
        // VideoEmbedURLBuilder produces for each provider.
        let providers: [(String, String, String)] = [
            ("youtube", "testVid1", "https://www.youtube.com/embed/testVid1?autoplay=1&rel=0&playsinline=1"),
            ("vimeo", "12345", "https://player.vimeo.com/video/12345?autoplay=1"),
            ("loom", "aaaabbbb", "https://www.loom.com/embed/aaaabbbb?autoplay=1"),
        ]

        for (provider, videoID, expectedString) in providers {
            let builtURL = VideoEmbedURLBuilder.buildEmbedURL(provider: provider, videoID: videoID)
            XCTAssertNotNil(builtURL, "Expected non-nil URL for provider \(provider)")
            XCTAssertEqual(builtURL?.absoluteString, expectedString)
        }
    }

    func testCardFallsBackToEmbedURLForUnknownProvider() {
        // When VideoEmbedURLBuilder returns nil for an unknown provider,
        // the card should use the raw embedURL as a fallback.
        let fallbackURL = URL(string: "https://custom.example.com/embed/vid99")!
        let result = VideoEmbedURLBuilder.buildEmbedURL(provider: "custom", videoID: "vid99")

        // Builder returns nil for unknown providers
        XCTAssertNil(result)

        // Card can still be created — it will use fallbackURL at render time
        let card = InlineVideoEmbedCard(
            provider: "custom",
            videoID: "vid99",
            embedURL: fallbackURL
        )
        XCTAssertEqual(card.embedURL, fallbackURL)
    }
}
