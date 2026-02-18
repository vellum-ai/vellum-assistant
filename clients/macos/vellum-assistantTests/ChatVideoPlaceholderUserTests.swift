import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ChatVideoPlaceholderUserTests: XCTestCase {

    // MARK: - Helpers

    private func makeUserMessage(
        _ text: String,
        timestamp: Date = Date()
    ) -> ChatMessage {
        ChatMessage(role: .user, text: text, timestamp: timestamp)
    }

    private func enabledSettings(
        enabledSince: Date? = nil,
        allowedDomains: [String] = ["youtube.com", "youtu.be", "vimeo.com", "loom.com"]
    ) -> MediaEmbedResolverSettings {
        MediaEmbedResolverSettings(
            enabled: true,
            enabledSince: enabledSince,
            allowedDomains: allowedDomains
        )
    }

    private func disabledSettings() -> MediaEmbedResolverSettings {
        MediaEmbedResolverSettings(enabled: false, enabledSince: nil, allowedDomains: [])
    }

    // MARK: - Video intents for user messages

    func testUserMessageWithYouTubeURLReturnsVideoIntent() async {
        let message = makeUserMessage("Check this out: https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        let result = await MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        let videos = result.filter { if case .video = $0 { return true } else { return false } }
        XCTAssertEqual(videos.count, 1)
        if case .video(let provider, let videoID, _) = videos.first {
            XCTAssertEqual(provider, "youtube")
            XCTAssertEqual(videoID, "dQw4w9WgXcQ")
        } else {
            XCTFail("Expected video intent")
        }
    }

    func testUserMessageWithVimeoURLReturnsVideoIntent() async {
        let message = makeUserMessage("Watch this: https://vimeo.com/76979871")
        let result = await MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        let videos = result.filter { if case .video = $0 { return true } else { return false } }
        XCTAssertEqual(videos.count, 1)
        if case .video(let provider, let videoID, _) = videos.first {
            XCTAssertEqual(provider, "vimeo")
            XCTAssertEqual(videoID, "76979871")
        } else {
            XCTFail("Expected video intent")
        }
    }

    func testUserMessageWithLoomURLReturnsVideoIntent() async {
        let message = makeUserMessage("Here's my recording: https://www.loom.com/share/abc123def456")
        let result = await MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        let videos = result.filter { if case .video = $0 { return true } else { return false } }
        XCTAssertEqual(videos.count, 1)
        if case .video(let provider, let videoID, _) = videos.first {
            XCTAssertEqual(provider, "loom")
            XCTAssertEqual(videoID, "abc123def456")
        } else {
            XCTFail("Expected video intent")
        }
    }

    // MARK: - Non-video URLs

    func testUserMessageWithNoVideoURLsReturnsNoVideoIntents() async {
        let message = makeUserMessage("Check https://example.com/page for details")
        let result = await MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        let videos = result.filter { if case .video = $0 { return true } else { return false } }
        XCTAssertEqual(videos, [])
    }

    // MARK: - Feature disabled

    func testDisabledSettingsReturnsEmptyForUserVideo() async {
        let message = makeUserMessage("Watch: https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        let result = await MediaEmbedResolver.resolve(message: message, settings: disabledSettings())
        XCTAssertEqual(result, [])
    }

    // MARK: - enabledSince gating

    func testUserVideoBeforeEnabledSinceReturnsEmpty() async {
        let cutoff = Date()
        let oldTimestamp = cutoff.addingTimeInterval(-60)
        let message = makeUserMessage(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            timestamp: oldTimestamp
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = await MediaEmbedResolver.resolve(message: message, settings: settings)
        XCTAssertEqual(result, [])
    }

    func testUserVideoAfterEnabledSinceReturnsVideoIntent() async {
        let cutoff = Date().addingTimeInterval(-120)
        let message = makeUserMessage(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            timestamp: Date()
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = await MediaEmbedResolver.resolve(message: message, settings: settings)
        let videos = result.filter { if case .video = $0 { return true } else { return false } }
        XCTAssertEqual(videos.count, 1)
    }
}
