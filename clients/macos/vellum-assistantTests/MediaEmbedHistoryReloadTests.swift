import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MediaEmbedHistoryReloadTests: XCTestCase {

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
    /// domains allowed.
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

    // MARK: - Old messages (before enabledSince) loaded from history produce no embeds

    func testOldHistoryMessagesProduceNoEmbeds() {
        let enabledAt = Date()
        let historicMessages = [
            makeMessage("https://www.youtube.com/watch?v=hist1", timestamp: enabledAt.addingTimeInterval(-3600)),
            makeMessage("https://www.youtube.com/watch?v=hist2", timestamp: enabledAt.addingTimeInterval(-7200)),
            makeMessage("https://vimeo.com/11111111", timestamp: enabledAt.addingTimeInterval(-600)),
        ]
        let settings = enabledSettings(enabledSince: enabledAt)

        for message in historicMessages {
            let result = MediaEmbedResolver.resolve(message: message, settings: settings)
            XCTAssertEqual(result, [], "Historic message before enabledSince should produce no embeds")
        }
    }

    // MARK: - New messages (after enabledSince) loaded from history produce embeds

    func testNewHistoryMessagesProduceEmbeds() {
        let enabledAt = Date().addingTimeInterval(-3600)
        let recentMessages = [
            makeMessage("https://www.youtube.com/watch?v=new1", timestamp: enabledAt.addingTimeInterval(60)),
            makeMessage("https://vimeo.com/22222222", timestamp: enabledAt.addingTimeInterval(120)),
            makeMessage("https://example.com/photo.png", timestamp: enabledAt.addingTimeInterval(180)),
        ]
        let settings = enabledSettings(enabledSince: enabledAt)

        for message in recentMessages {
            let result = MediaEmbedResolver.resolve(message: message, settings: settings)
            XCTAssertEqual(result.count, 1, "Message after enabledSince should produce exactly one embed")
        }
    }

    // MARK: - Mixed old and new messages — only new ones get embeds

    func testMixedHistoryOnlyNewMessagesGetEmbeds() {
        let enabledAt = Date().addingTimeInterval(-1800)
        let settings = enabledSettings(enabledSince: enabledAt)

        let oldMessage = makeMessage(
            "https://www.youtube.com/watch?v=old1",
            timestamp: enabledAt.addingTimeInterval(-300)
        )
        let newMessage = makeMessage(
            "https://www.youtube.com/watch?v=new1",
            timestamp: enabledAt.addingTimeInterval(300)
        )

        let oldResult = MediaEmbedResolver.resolve(message: oldMessage, settings: settings)
        let newResult = MediaEmbedResolver.resolve(message: newMessage, settings: settings)

        XCTAssertEqual(oldResult, [], "Old message in mixed history should produce no embeds")
        XCTAssertEqual(newResult.count, 1, "New message in mixed history should produce embeds")
        if case .video(let provider, let videoID, _) = newResult.first {
            XCTAssertEqual(provider, "youtube")
            XCTAssertEqual(videoID, "new1")
        } else {
            XCTFail("Expected video intent for new message")
        }
    }

    // MARK: - Re-enabling embeds (new enabledSince) doesn't affect old history

    func testReEnablingEmbedsDoesNotAffectOldHistory() {
        // Simulate: embeds were first enabled at T-7200, disabled, then re-enabled at T-60.
        // Messages between T-7200 and T-60 should NOT get embeds under the new enabledSince.
        let reEnabledAt = Date().addingTimeInterval(-60)
        let settings = enabledSettings(enabledSince: reEnabledAt)

        let messageDuringFirstEnable = makeMessage(
            "https://www.youtube.com/watch?v=firstEra",
            timestamp: reEnabledAt.addingTimeInterval(-3600)
        )
        let messageAfterReEnable = makeMessage(
            "https://www.youtube.com/watch?v=secondEra",
            timestamp: reEnabledAt.addingTimeInterval(10)
        )

        let firstResult = MediaEmbedResolver.resolve(message: messageDuringFirstEnable, settings: settings)
        let secondResult = MediaEmbedResolver.resolve(message: messageAfterReEnable, settings: settings)

        XCTAssertEqual(firstResult, [], "Message from first era should be blocked by new enabledSince")
        XCTAssertEqual(secondResult.count, 1, "Message after re-enable should produce embeds")
    }

    // MARK: - Messages at exact boundary timestamp

    func testMessageAtExactBoundaryTimestamp() {
        let boundary = Date()
        let message = makeMessage(
            "https://www.youtube.com/watch?v=boundary1",
            timestamp: boundary
        )
        // The resolver uses `<` — a message whose timestamp equals enabledSince is NOT
        // less-than, so it should pass the gate and produce embeds.
        let settings = enabledSettings(enabledSince: boundary)
        let result = MediaEmbedResolver.resolve(message: message, settings: settings)
        XCTAssertEqual(result.count, 1, "Message at exact boundary should be allowed (not strictly less-than)")
        if case .video(_, let videoID, _) = result.first {
            XCTAssertEqual(videoID, "boundary1")
        } else {
            XCTFail("Expected video intent at boundary")
        }
    }

    // MARK: - Image and video embeds both respect history gating

    func testImageEmbedRespectsHistoryGating() {
        let enabledAt = Date()
        let settings = enabledSettings(enabledSince: enabledAt)

        let oldImage = makeMessage(
            "Screenshot: https://example.com/old-screenshot.png",
            timestamp: enabledAt.addingTimeInterval(-120)
        )
        let newImage = makeMessage(
            "Screenshot: https://example.com/new-screenshot.jpg",
            timestamp: enabledAt.addingTimeInterval(120)
        )

        let oldResult = MediaEmbedResolver.resolve(message: oldImage, settings: settings)
        let newResult = MediaEmbedResolver.resolve(message: newImage, settings: settings)

        XCTAssertEqual(oldResult, [], "Old image should be blocked by history gate")
        XCTAssertEqual(newResult.count, 1, "New image should pass history gate")
        if case .image(let url) = newResult.first {
            XCTAssertTrue(url.absoluteString.contains("new-screenshot.jpg"))
        } else {
            XCTFail("Expected image intent for new screenshot")
        }
    }

    func testVideoEmbedRespectsHistoryGating() {
        let enabledAt = Date()
        let settings = enabledSettings(enabledSince: enabledAt)

        let oldVideo = makeMessage(
            "Watch: https://vimeo.com/99999999",
            timestamp: enabledAt.addingTimeInterval(-300)
        )
        let newVideo = makeMessage(
            "Watch: https://vimeo.com/88888888",
            timestamp: enabledAt.addingTimeInterval(300)
        )

        let oldResult = MediaEmbedResolver.resolve(message: oldVideo, settings: settings)
        let newResult = MediaEmbedResolver.resolve(message: newVideo, settings: settings)

        XCTAssertEqual(oldResult, [], "Old video should be blocked by history gate")
        XCTAssertEqual(newResult.count, 1, "New video should pass history gate")
        if case .video(let provider, let videoID, _) = newResult.first {
            XCTAssertEqual(provider, "vimeo")
            XCTAssertEqual(videoID, "88888888")
        } else {
            XCTFail("Expected video intent for new Vimeo link")
        }
    }

    // MARK: - Sequence of messages spanning the enabledSince boundary

    func testMessageSequenceSpanningBoundary() {
        let enabledAt = Date().addingTimeInterval(-1000)
        let settings = enabledSettings(enabledSince: enabledAt)

        // Simulate a realistic conversation history with messages at various offsets
        let messages: [(text: String, offset: TimeInterval, shouldEmbed: Bool)] = [
            ("https://www.youtube.com/watch?v=seq1", -3600, false),
            ("https://vimeo.com/11111111",           -1800, false),
            ("https://example.com/early.png",         -500, false),
            ("https://www.youtube.com/watch?v=seq4",     0, true),  // at boundary
            ("https://example.com/recent.jpg",         100, true),
            ("https://vimeo.com/22222222",             500, true),
            ("https://www.youtube.com/watch?v=seq7",  1000, true),
        ]

        for (index, entry) in messages.enumerated() {
            let message = makeMessage(entry.text, timestamp: enabledAt.addingTimeInterval(entry.offset))
            let result = MediaEmbedResolver.resolve(message: message, settings: settings)

            if entry.shouldEmbed {
                XCTAssertEqual(
                    result.count, 1,
                    "Message \(index) (offset \(entry.offset)s) should produce an embed"
                )
            } else {
                XCTAssertEqual(
                    result, [],
                    "Message \(index) (offset \(entry.offset)s) should produce no embeds"
                )
            }
        }
    }
}
