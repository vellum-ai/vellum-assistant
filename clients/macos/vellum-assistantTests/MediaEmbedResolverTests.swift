import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MediaEmbedResolverTests: XCTestCase {

    // MARK: - Helpers

    /// Builds a ChatMessage with the given text, role, and timestamp.
    private func makeMessage(
        _ text: String,
        role: ChatRole = .assistant,
        timestamp: Date = Date()
    ) -> ChatMessage {
        ChatMessage(role: role, text: text, timestamp: timestamp)
    }

    /// Returns settings with the feature enabled and all common video
    /// domains allowed. `enabledSince` defaults to nil (allow all).
    private func enabledSettings(
        enabledSince: Date? = nil,
        allowedDomains: [String] = [
            "youtube.com", "youtu.be",
            "vimeo.com",
            "loom.com",
        ]
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

    // MARK: - Feature gate: disabled

    func testDisabledSettingsReturnsEmpty() {
        let message = makeMessage("Check https://www.youtube.com/watch?v=abc123")
        let result = MediaEmbedResolver.resolve(message: message, settings: disabledSettings())
        XCTAssertEqual(result, [])
    }

    // MARK: - Feature gate: enabledSince

    func testMessageBeforeEnabledSinceReturnsEmpty() {
        let cutoff = Date()
        let oldTimestamp = cutoff.addingTimeInterval(-60)
        let message = makeMessage(
            "https://www.youtube.com/watch?v=abc123",
            timestamp: oldTimestamp
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = MediaEmbedResolver.resolve(message: message, settings: settings)
        XCTAssertEqual(result, [])
    }

    func testMessageAfterEnabledSinceResolves() {
        let cutoff = Date().addingTimeInterval(-120)
        let message = makeMessage(
            "https://www.youtube.com/watch?v=abc123",
            timestamp: Date()
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = MediaEmbedResolver.resolve(message: message, settings: settings)
        XCTAssertEqual(result.count, 1)
        if case .video(let provider, let videoID, _) = result.first {
            XCTAssertEqual(provider, "youtube")
            XCTAssertEqual(videoID, "abc123")
        } else {
            XCTFail("Expected video intent")
        }
    }

    func testNilEnabledSinceAllowsAllMessages() {
        let veryOld = Date.distantPast
        let message = makeMessage(
            "https://www.youtube.com/watch?v=old123",
            timestamp: veryOld
        )
        let settings = enabledSettings(enabledSince: nil)
        let result = MediaEmbedResolver.resolve(message: message, settings: settings)
        XCTAssertEqual(result.count, 1)
    }

    // MARK: - Video providers

    func testYouTubeURLResolvesToVideoIntent() {
        let message = makeMessage("Watch this: https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result.count, 1)
        if case .video(let provider, let videoID, let embedURL) = result.first {
            XCTAssertEqual(provider, "youtube")
            XCTAssertEqual(videoID, "dQw4w9WgXcQ")
            XCTAssertEqual(embedURL.absoluteString, "https://www.youtube.com/embed/dQw4w9WgXcQ")
        } else {
            XCTFail("Expected video intent")
        }
    }

    func testVimeoURLResolvesToVideoIntent() {
        let message = makeMessage("See https://vimeo.com/76979871")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result.count, 1)
        if case .video(let provider, let videoID, let embedURL) = result.first {
            XCTAssertEqual(provider, "vimeo")
            XCTAssertEqual(videoID, "76979871")
            XCTAssertEqual(embedURL.absoluteString, "https://player.vimeo.com/video/76979871")
        } else {
            XCTFail("Expected video intent")
        }
    }

    func testLoomURLResolvesToVideoIntent() {
        let message = makeMessage("Recording: https://www.loom.com/share/abc123def456")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result.count, 1)
        if case .video(let provider, let videoID, let embedURL) = result.first {
            XCTAssertEqual(provider, "loom")
            XCTAssertEqual(videoID, "abc123def456")
            XCTAssertEqual(embedURL.absoluteString, "https://www.loom.com/embed/abc123def456")
        } else {
            XCTFail("Expected video intent")
        }
    }

    // MARK: - Image classification

    func testImageURLResolvesToImageIntent() {
        let message = makeMessage("Here's a screenshot: https://example.com/photo.png")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result.count, 1)
        if case .image(let url) = result.first {
            XCTAssertEqual(url.absoluteString, "https://example.com/photo.png")
        } else {
            XCTFail("Expected image intent")
        }
    }

    // MARK: - Domain allowlist

    func testNonAllowedDomainVideoURLIsSkipped() {
        let message = makeMessage("https://www.youtube.com/watch?v=abc123")
        // Settings with no allowed domains for video providers
        let settings = MediaEmbedResolverSettings(
            enabled: true,
            enabledSince: nil,
            allowedDomains: ["example.com"]
        )
        let result = MediaEmbedResolver.resolve(message: message, settings: settings)
        XCTAssertEqual(result, [])
    }

    // MARK: - Mixed URLs

    func testMixedImageAndVideoURLs() {
        let message = makeMessage(
            "Video: https://www.youtube.com/watch?v=abc123 and image: https://cdn.example.com/pic.jpg"
        )
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result.count, 2)

        if case .video(let provider, _, _) = result[0] {
            XCTAssertEqual(provider, "youtube")
        } else {
            XCTFail("Expected video intent first")
        }

        if case .image(let url) = result[1] {
            XCTAssertTrue(url.absoluteString.contains("pic.jpg"))
        } else {
            XCTFail("Expected image intent second")
        }
    }

    // MARK: - Deduplication

    func testDuplicateURLsAreDeduped() {
        let message = makeMessage(
            "https://www.youtube.com/watch?v=abc123 and again https://www.youtube.com/watch?v=abc123"
        )
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result.count, 1)
    }

    // MARK: - Code blocks excluded

    func testURLsInCodeBlocksAreExcluded() {
        let message = makeMessage("""
        Here is some code:
        ```
        https://www.youtube.com/watch?v=abc123
        ```
        """)
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result, [])
    }

    // MARK: - Plain text, no URLs

    func testPlainTextWithNoURLsReturnsEmpty() {
        let message = makeMessage("Just a regular message with no links.")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result, [])
    }

    // MARK: - Role-agnostic

    func testUserMessageResolves() {
        let message = makeMessage(
            "https://www.youtube.com/watch?v=user123",
            role: .user
        )
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result.count, 1)
        if case .video(_, let videoID, _) = result.first {
            XCTAssertEqual(videoID, "user123")
        } else {
            XCTFail("Expected video intent for user message")
        }
    }

    func testAssistantMessageResolves() {
        let message = makeMessage(
            "https://www.youtube.com/watch?v=asst456",
            role: .assistant
        )
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result.count, 1)
        if case .video(_, let videoID, _) = result.first {
            XCTAssertEqual(videoID, "asst456")
        } else {
            XCTFail("Expected video intent for assistant message")
        }
    }
}
