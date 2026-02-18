import XCTest
@testable import VellumAssistantLib

@MainActor
final class InlineVideoEmbedCardTests: XCTestCase {

    // MARK: - Instantiation & property storage

    func testYouTubeCardStoresProperties() {
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

    func testVimeoCardStoresProperties() {
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

    func testLoomCardStoresProperties() {
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

    // MARK: - Different embed URLs

    func testEmbedURLPreservedExactly() {
        let urlString = "https://custom-player.example.com/embed/vid-999?autoplay=0"
        let url = URL(string: urlString)!
        let card = InlineVideoEmbedCard(
            provider: "custom",
            videoID: "vid-999",
            embedURL: url
        )

        XCTAssertEqual(card.embedURL.absoluteString, urlString)
    }
}
