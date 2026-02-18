import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ChatVideoPlaceholderAssistantTests: XCTestCase {

    // MARK: - Helpers

    private func makeAssistantMessage(
        _ text: String,
        timestamp: Date = Date()
    ) -> ChatMessage {
        ChatMessage(role: .assistant, text: text, timestamp: timestamp)
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

    // MARK: - Video intents for assistant messages

    func testAssistantMessageWithYouTubeURLReturnsVideoIntent() {
        let message = makeAssistantMessage("Check this out: https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        let videos = result.filter { if case .video = $0 { return true } else { return false } }
        XCTAssertEqual(videos.count, 1)
        if case .video(let provider, let videoID, _) = videos.first {
            XCTAssertEqual(provider, "youtube")
            XCTAssertEqual(videoID, "dQw4w9WgXcQ")
        } else {
            XCTFail("Expected video intent")
        }
    }

    func testAssistantMessageWithVimeoURLReturnsVideoIntent() {
        let message = makeAssistantMessage("Watch this: https://vimeo.com/76979871")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        let videos = result.filter { if case .video = $0 { return true } else { return false } }
        XCTAssertEqual(videos.count, 1)
        if case .video(let provider, let videoID, _) = videos.first {
            XCTAssertEqual(provider, "vimeo")
            XCTAssertEqual(videoID, "76979871")
        } else {
            XCTFail("Expected video intent")
        }
    }

    func testAssistantMessageWithLoomURLReturnsVideoIntent() {
        let message = makeAssistantMessage("Here's my recording: https://www.loom.com/share/abc123def456")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
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

    func testAssistantMessageWithNonVideoURLReturnsNoVideoIntents() {
        let message = makeAssistantMessage("Check https://example.com/page for details")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        let videos = result.filter { if case .video = $0 { return true } else { return false } }
        XCTAssertEqual(videos, [])
    }

    // MARK: - Feature disabled

    func testDisabledSettingsReturnsEmptyForVideo() {
        let message = makeAssistantMessage("Watch: https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        let result = MediaEmbedResolver.resolve(message: message, settings: disabledSettings())
        XCTAssertEqual(result, [])
    }

    // MARK: - enabledSince gating

    func testAssistantVideoBeforeEnabledSinceReturnsEmpty() {
        let cutoff = Date()
        let oldTimestamp = cutoff.addingTimeInterval(-60)
        let message = makeAssistantMessage(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            timestamp: oldTimestamp
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = MediaEmbedResolver.resolve(message: message, settings: settings)
        XCTAssertEqual(result, [])
    }

    func testAssistantVideoAfterEnabledSinceReturnsVideoIntent() {
        let cutoff = Date().addingTimeInterval(-120)
        let message = makeAssistantMessage(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            timestamp: Date()
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = MediaEmbedResolver.resolve(message: message, settings: settings)
        let videos = result.filter { if case .video = $0 { return true } else { return false } }
        XCTAssertEqual(videos.count, 1)
    }

    // MARK: - Domain allowlist

    func testNonAllowedDomainIsSkipped() {
        let message = makeAssistantMessage("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        // Only allow vimeo.com — youtube.com should be skipped
        let settings = enabledSettings(allowedDomains: ["vimeo.com"])
        let result = MediaEmbedResolver.resolve(message: message, settings: settings)
        let videos = result.filter { if case .video = $0 { return true } else { return false } }
        XCTAssertEqual(videos, [])
    }
}
