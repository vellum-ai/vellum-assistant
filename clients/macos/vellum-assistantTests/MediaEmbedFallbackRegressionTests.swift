import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Regression tests that verify unsupported, insecure, and non-embeddable URLs
/// gracefully produce zero embeds, while leaving the original message text
/// untouched.
@MainActor
final class MediaEmbedFallbackRegressionTests: XCTestCase {

    // MARK: - Helpers

    private func makeMessage(
        _ text: String,
        role: ChatRole = .assistant,
        timestamp: Date = Date()
    ) -> ChatMessage {
        ChatMessage(role: role, text: text, timestamp: timestamp)
    }

    private func enabledSettings(
        allowedDomains: [String] = [
            "youtube.com", "youtu.be",
            "vimeo.com",
            "loom.com",
        ]
    ) -> MediaEmbedResolverSettings {
        MediaEmbedResolverSettings(
            enabled: true,
            enabledSince: nil,
            allowedDomains: allowedDomains
        )
    }

    // MARK: - Unsupported video providers

    func testUnsupportedVideoProviderDailymotionProducesNoEmbeds() {
        let message = makeMessage("Check this out: https://www.dailymotion.com/video/x8abc12")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result, [], "Dailymotion is not a supported video provider")
    }

    func testUnsupportedVideoProviderTwitchProducesNoEmbeds() {
        let message = makeMessage("Live stream: https://www.twitch.tv/some_channel")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result, [], "Twitch is not a supported video provider")
    }

    // MARK: - Non-image, non-video URLs

    func testGitHubURLProducesNoEmbeds() {
        let message = makeMessage("See the repo at https://github.com/apple/swift")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result, [], "Generic GitHub URLs should not produce embeds")
    }

    func testGoogleDocsURLProducesNoEmbeds() {
        let message = makeMessage("Read the doc: https://docs.google.com/document/d/1abc/edit")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result, [], "Google Docs URLs should not produce embeds")
    }

    // MARK: - HTTP (insecure) image URLs

    func testHTTPImageURLProducesNoEmbeds() {
        let message = makeMessage("Look at http://example.com/photo.png")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result, [], "HTTP image URLs should be rejected; only HTTPS is allowed")
    }

    // MARK: - HTTP (insecure) video URLs

    func testHTTPVideoURLProducesNoEmbeds() {
        let message = makeMessage("Watch http://www.youtube.com/watch?v=abc123")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result, [], "HTTP video URLs should not produce embeds")
    }

    // MARK: - FTP and mailto URLs

    func testFTPURLProducesNoEmbeds() {
        let message = makeMessage("Download from ftp://files.example.com/archive.zip")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result, [], "FTP URLs should not produce embeds")
    }

    func testMailtoURLProducesNoEmbeds() {
        let message = makeMessage("Email us at mailto:help@example.com")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result, [], "mailto URLs should not produce embeds")
    }

    // MARK: - Non-allowlisted video domains

    func testVideoURLFromNonAllowlistedDomainProducesNoEmbeds() {
        // YouTube URL, but youtube.com is not in the allowed domains list.
        let message = makeMessage("https://www.youtube.com/watch?v=xyz789")
        let settings = MediaEmbedResolverSettings(
            enabled: true,
            enabledSince: nil,
            allowedDomains: ["example.com"]
        )
        let result = MediaEmbedResolver.resolve(message: message, settings: settings)
        XCTAssertEqual(result, [], "Video URL from a non-allowlisted domain should not embed")
    }

    // MARK: - URLs inside code blocks

    func testURLInsideCodeBlockProducesNoEmbeds() {
        let text = """
        Here is a code example:
        ```
        https://www.youtube.com/watch?v=abc123
        https://example.com/photo.png
        ```
        """
        let message = makeMessage(text)
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result, [], "URLs inside fenced code blocks should not produce embeds")
    }

    // MARK: - URLs inside inline code

    func testURLInsideInlineCodeProducesNoEmbeds() {
        let message = makeMessage("Use `https://www.youtube.com/watch?v=abc123` as the endpoint")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result, [], "URLs inside inline code should not produce embeds")
    }

    // MARK: - Plain text without URLs

    func testPlainTextWithoutURLsProducesNoEmbeds() {
        let message = makeMessage("This is just a regular message with no links at all.")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result, [], "Plain text with no URLs should produce no embeds")
    }

    // MARK: - Message text is unchanged (embeds are additive)

    func testMessageTextIsUnchangedAfterResolution() {
        let originalText = "Watch this: https://www.youtube.com/watch?v=dQw4w9WgXcQ and this image https://cdn.example.com/pic.jpg"
        let message = makeMessage(originalText)
        let _ = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(
            message.text,
            originalText,
            "Resolving embeds must not mutate the original message text"
        )
    }
}
