import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ChatImageEmbedAssistantTests: XCTestCase {

    // MARK: - Helpers

    private func makeAssistantMessage(
        _ text: String,
        timestamp: Date = Date()
    ) -> ChatMessage {
        ChatMessage(role: .assistant, text: text, timestamp: timestamp)
    }

    private func enabledSettings(
        enabledSince: Date? = nil
    ) -> MediaEmbedResolverSettings {
        MediaEmbedResolverSettings(
            enabled: true,
            enabledSince: enabledSince,
            allowedDomains: []
        )
    }

    private func disabledSettings() -> MediaEmbedResolverSettings {
        MediaEmbedResolverSettings(enabled: false, enabledSince: nil, allowedDomains: [])
    }

    // MARK: - Image intents for assistant messages

    func testAssistantMessageWithImageURLReturnsImageIntent() async {
        let message = makeAssistantMessage("Here is a screenshot: https://example.com/photo.png")
        let result = await MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result.count, 1)
        if case .image(let url) = result.first {
            XCTAssertEqual(url.absoluteString, "https://example.com/photo.png")
        } else {
            XCTFail("Expected image intent")
        }
    }

    // MARK: - No URLs

    func testAssistantMessageWithNoURLsReturnsEmpty() async {
        let message = makeAssistantMessage("Just a plain assistant response with no links.")
        let result = await MediaEmbedResolver.resolve(message: message, settings: enabledSettings())
        XCTAssertEqual(result, [])
    }

    // MARK: - Feature disabled

    func testDisabledSettingsReturnsEmptyForAssistant() async {
        let message = makeAssistantMessage("Check this image: https://example.com/photo.png")
        let result = await MediaEmbedResolver.resolve(message: message, settings: disabledSettings())
        XCTAssertEqual(result, [])
    }

    // MARK: - enabledSince gating

    func testAssistantMessageBeforeEnabledSinceReturnsEmpty() async {
        let cutoff = Date()
        let oldTimestamp = cutoff.addingTimeInterval(-60)
        let message = makeAssistantMessage(
            "https://example.com/old-photo.png",
            timestamp: oldTimestamp
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = await MediaEmbedResolver.resolve(message: message, settings: settings)
        XCTAssertEqual(result, [])
    }

    func testAssistantMessageAfterEnabledSinceReturnsImageIntent() async {
        let cutoff = Date().addingTimeInterval(-120)
        let message = makeAssistantMessage(
            "https://example.com/new-photo.jpg",
            timestamp: Date()
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = await MediaEmbedResolver.resolve(message: message, settings: settings)
        XCTAssertEqual(result.count, 1)
        if case .image(let url) = result.first {
            XCTAssertTrue(url.absoluteString.contains("new-photo.jpg"))
        } else {
            XCTFail("Expected image intent")
        }
    }
}
