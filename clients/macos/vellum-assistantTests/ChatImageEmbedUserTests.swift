import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ChatImageEmbedUserTests: XCTestCase {

    // MARK: - Helpers

    private func makeUserMessage(
        _ text: String,
        timestamp: Date = Date()
    ) -> ChatMessage {
        ChatMessage(role: .user, text: text, timestamp: timestamp)
    }

    private func enabledSettings(
        enabledSince: Date? = nil
    ) -> MediaEmbedResolverSettings {
        MediaEmbedResolverSettings(
            enabled: true,
            enabledSince: enabledSince,
            allowedDomains: ["youtube.com", "youtu.be", "vimeo.com", "loom.com"]
        )
    }

    private func disabledSettings() -> MediaEmbedResolverSettings {
        MediaEmbedResolverSettings(enabled: false, enabledSince: nil, allowedDomains: [])
    }

    // MARK: - User message with image URL

    func testUserMessageWithImageURLReturnsImageIntent() {
        let message = makeUserMessage("Check this out: https://example.com/photo.png")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
            .filter { if case .image = $0 { return true } else { return false } }
        XCTAssertEqual(result.count, 1)
        if case .image(let url) = result.first {
            XCTAssertEqual(url.absoluteString, "https://example.com/photo.png")
        } else {
            XCTFail("Expected image intent")
        }
    }

    // MARK: - User message with no URLs

    func testUserMessageWithNoURLsReturnsEmpty() {
        let message = makeUserMessage("Just a plain text message, no links here.")
        let result = MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result, [])
    }

    // MARK: - Disabled feature returns empty for user messages

    func testUserMessageWithDisabledSettingsReturnsEmpty() {
        let message = makeUserMessage("Here is an image: https://example.com/img.jpg")
        let result = MediaEmbedResolver.resolve(message: message, settings: disabledSettings())
        XCTAssertEqual(result, [])
    }

    // MARK: - enabledSince gating for user messages

    func testUserMessageBeforeEnabledSinceReturnsEmpty() {
        let cutoff = Date()
        let oldTimestamp = cutoff.addingTimeInterval(-60)
        let message = makeUserMessage(
            "https://example.com/old-screenshot.png",
            timestamp: oldTimestamp
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = MediaEmbedResolver.resolve(message: message, settings: settings)
        XCTAssertEqual(result, [])
    }

    func testUserMessageAfterEnabledSinceReturnsImageIntent() {
        let cutoff = Date().addingTimeInterval(-120)
        let message = makeUserMessage(
            "https://example.com/new-screenshot.png",
            timestamp: Date()
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = MediaEmbedResolver.resolve(message: message, settings: settings)
            .filter { if case .image = $0 { return true } else { return false } }
        XCTAssertEqual(result.count, 1)
        if case .image(let url) = result.first {
            XCTAssertTrue(url.absoluteString.contains("new-screenshot.png"))
        } else {
            XCTFail("Expected image intent for user message after enabledSince")
        }
    }
}
