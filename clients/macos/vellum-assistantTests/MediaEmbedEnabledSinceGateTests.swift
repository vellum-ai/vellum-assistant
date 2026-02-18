import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MediaEmbedEnabledSinceGateTests: XCTestCase {

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

    // MARK: - Message BEFORE enabledSince returns no embeds

    func testMessageBeforeEnabledSinceReturnsEmpty() {
        let cutoff = Date()
        let oldMessage = makeMessage(
            "https://www.youtube.com/watch?v=abc123",
            timestamp: cutoff.addingTimeInterval(-60)
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = MediaEmbedResolver.resolve(message: oldMessage, settings: settings)
        XCTAssertEqual(result, [], "Messages created before enabledSince must produce no embeds")
    }

    // MARK: - Message AFTER enabledSince returns embeds

    func testMessageAfterEnabledSinceReturnsEmbeds() {
        let cutoff = Date().addingTimeInterval(-120)
        let newMessage = makeMessage(
            "https://www.youtube.com/watch?v=abc123",
            timestamp: Date()
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = MediaEmbedResolver.resolve(message: newMessage, settings: settings)
        XCTAssertEqual(result.count, 1, "Messages created after enabledSince must resolve embeds")
        if case .video(let provider, let videoID, _) = result.first {
            XCTAssertEqual(provider, "youtube")
            XCTAssertEqual(videoID, "abc123")
        } else {
            XCTFail("Expected video intent")
        }
    }

    // MARK: - Message EXACTLY at enabledSince boundary

    func testMessageExactlyAtEnabledSinceBoundaryIsAllowed() {
        let boundary = Date()
        let message = makeMessage(
            "https://www.youtube.com/watch?v=edge123",
            timestamp: boundary
        )
        // The resolver uses `<` — a message whose timestamp equals enabledSince is NOT
        // less-than, so it should pass the gate and produce embeds.
        let settings = enabledSettings(enabledSince: boundary)
        let result = MediaEmbedResolver.resolve(message: message, settings: settings)
        XCTAssertEqual(result.count, 1, "Message at exact boundary should be allowed (not strictly less-than)")
        if case .video(_, let videoID, _) = result.first {
            XCTAssertEqual(videoID, "edge123")
        } else {
            XCTFail("Expected video intent at boundary")
        }
    }

    // MARK: - nil enabledSince allows all messages

    func testNilEnabledSinceAllowsAllMessages() {
        let veryOldMessage = makeMessage(
            "https://www.youtube.com/watch?v=old123",
            timestamp: Date.distantPast
        )
        let settings = enabledSettings(enabledSince: nil)
        let result = MediaEmbedResolver.resolve(message: veryOldMessage, settings: settings)
        XCTAssertEqual(result.count, 1, "nil enabledSince should allow messages regardless of timestamp")
    }

    // MARK: - Very old enabledSince allows recent messages

    func testVeryOldEnabledSinceAllowsRecentMessages() {
        let ancientCutoff = Date.distantPast
        let recentMessage = makeMessage(
            "https://www.youtube.com/watch?v=recent123",
            timestamp: Date()
        )
        let settings = enabledSettings(enabledSince: ancientCutoff)
        let result = MediaEmbedResolver.resolve(message: recentMessage, settings: settings)
        XCTAssertEqual(result.count, 1, "Very old enabledSince should allow recent messages")
    }

    // MARK: - Future enabledSince blocks all current messages

    func testFutureEnabledSinceBlocksAllCurrentMessages() {
        let futureCutoff = Date.distantFuture
        let currentMessage = makeMessage(
            "https://www.youtube.com/watch?v=blocked123",
            timestamp: Date()
        )
        let settings = enabledSettings(enabledSince: futureCutoff)
        let result = MediaEmbedResolver.resolve(message: currentMessage, settings: settings)
        XCTAssertEqual(result, [], "Future enabledSince should block all current messages")
    }

    // MARK: - Toggle OFF->ON resets enabledSince (SettingsStore)

    func testToggleOffToOnResetsEnabledSince() {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let configPath = tempDir.appendingPathComponent("config.json").path
        let json = #"{"ui":{"mediaEmbeds":{"enabled":false}}}"#
        try! json.write(toFile: configPath, atomically: true, encoding: .utf8)

        let store = SettingsStore(configPath: configPath)
        XCTAssertFalse(store.mediaEmbedsEnabled)
        // enabledSince is defaulted to now when the key is missing from config
        XCTAssertNotNil(store.mediaEmbedsEnabledSince)
        let initialSince = store.mediaEmbedsEnabledSince!

        let before = Date()
        store.setMediaEmbedsEnabled(true)
        let after = Date()

        XCTAssertTrue(store.mediaEmbedsEnabled)
        XCTAssertNotNil(store.mediaEmbedsEnabledSince, "enabledSince should be set when toggling ON")

        let since = store.mediaEmbedsEnabledSince!
        XCTAssertGreaterThanOrEqual(since, before)
        XCTAssertLessThanOrEqual(since, after)
        XCTAssertGreaterThanOrEqual(since, initialSince, "Toggle ON should reset enabledSince to a newer date")
    }

    // MARK: - Image embeds respect enabledSince

    func testImageEmbedRespectsEnabledSince_Blocked() {
        let cutoff = Date()
        let oldMessage = makeMessage(
            "Here is a screenshot: https://example.com/photo.png",
            timestamp: cutoff.addingTimeInterval(-30)
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = MediaEmbedResolver.resolve(message: oldMessage, settings: settings)
        XCTAssertEqual(result, [], "Image embed should be blocked when message predates enabledSince")
    }

    func testImageEmbedRespectsEnabledSince_Allowed() {
        let cutoff = Date().addingTimeInterval(-120)
        let newMessage = makeMessage(
            "Here is a screenshot: https://example.com/photo.png",
            timestamp: Date()
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = MediaEmbedResolver.resolve(message: newMessage, settings: settings)
        XCTAssertEqual(result.count, 1, "Image embed should be allowed when message is after enabledSince")
        if case .image(let url) = result.first {
            XCTAssertTrue(url.absoluteString.contains("photo.png"))
        } else {
            XCTFail("Expected image intent")
        }
    }

    // MARK: - Video embeds respect enabledSince

    func testVideoEmbedRespectsEnabledSince_Blocked() {
        let cutoff = Date()
        let oldMessage = makeMessage(
            "Watch this: https://vimeo.com/76979871",
            timestamp: cutoff.addingTimeInterval(-45)
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = MediaEmbedResolver.resolve(message: oldMessage, settings: settings)
        XCTAssertEqual(result, [], "Video embed should be blocked when message predates enabledSince")
    }

    func testVideoEmbedRespectsEnabledSince_Allowed() {
        let cutoff = Date().addingTimeInterval(-120)
        let newMessage = makeMessage(
            "Watch this: https://vimeo.com/76979871",
            timestamp: Date()
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = MediaEmbedResolver.resolve(message: newMessage, settings: settings)
        XCTAssertEqual(result.count, 1, "Video embed should be allowed when message is after enabledSince")
        if case .video(let provider, let videoID, _) = result.first {
            XCTAssertEqual(provider, "vimeo")
            XCTAssertEqual(videoID, "76979871")
        } else {
            XCTFail("Expected video intent")
        }
    }

    // MARK: - Mixed image+video message respects enabledSince

    func testMixedImageVideoRespectsEnabledSince_Blocked() {
        let cutoff = Date()
        let oldMessage = makeMessage(
            "Video: https://www.youtube.com/watch?v=mix123 and image: https://cdn.example.com/pic.jpg",
            timestamp: cutoff.addingTimeInterval(-10)
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = MediaEmbedResolver.resolve(message: oldMessage, settings: settings)
        XCTAssertEqual(result, [], "Mixed message should be blocked entirely when it predates enabledSince")
    }

    func testMixedImageVideoRespectsEnabledSince_Allowed() {
        let cutoff = Date().addingTimeInterval(-120)
        let newMessage = makeMessage(
            "Video: https://www.youtube.com/watch?v=mix456 and image: https://cdn.example.com/pic.jpg",
            timestamp: Date()
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = MediaEmbedResolver.resolve(message: newMessage, settings: settings)
        XCTAssertEqual(result.count, 2, "Mixed message should produce both embeds when after enabledSince")
    }

    // MARK: - User messages respect enabledSince

    func testUserMessageRespectsEnabledSince_Blocked() {
        let cutoff = Date()
        let oldUserMessage = makeMessage(
            "https://www.youtube.com/watch?v=user123",
            role: .user,
            timestamp: cutoff.addingTimeInterval(-60)
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = MediaEmbedResolver.resolve(message: oldUserMessage, settings: settings)
        XCTAssertEqual(result, [], "User messages before enabledSince should produce no embeds")
    }

    func testUserMessageRespectsEnabledSince_Allowed() {
        let cutoff = Date().addingTimeInterval(-120)
        let newUserMessage = makeMessage(
            "https://www.youtube.com/watch?v=user456",
            role: .user,
            timestamp: Date()
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = MediaEmbedResolver.resolve(message: newUserMessage, settings: settings)
        XCTAssertEqual(result.count, 1, "User messages after enabledSince should produce embeds")
        if case .video(_, let videoID, _) = result.first {
            XCTAssertEqual(videoID, "user456")
        } else {
            XCTFail("Expected video intent for user message")
        }
    }

    // MARK: - Assistant messages respect enabledSince

    func testAssistantMessageRespectsEnabledSince_Blocked() {
        let cutoff = Date()
        let oldAssistantMessage = makeMessage(
            "https://www.youtube.com/watch?v=asst123",
            role: .assistant,
            timestamp: cutoff.addingTimeInterval(-60)
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = MediaEmbedResolver.resolve(message: oldAssistantMessage, settings: settings)
        XCTAssertEqual(result, [], "Assistant messages before enabledSince should produce no embeds")
    }

    func testAssistantMessageRespectsEnabledSince_Allowed() {
        let cutoff = Date().addingTimeInterval(-120)
        let newAssistantMessage = makeMessage(
            "https://www.youtube.com/watch?v=asst456",
            role: .assistant,
            timestamp: Date()
        )
        let settings = enabledSettings(enabledSince: cutoff)
        let result = MediaEmbedResolver.resolve(message: newAssistantMessage, settings: settings)
        XCTAssertEqual(result.count, 1, "Assistant messages after enabledSince should produce embeds")
        if case .video(_, let videoID, _) = result.first {
            XCTAssertEqual(videoID, "asst456")
        } else {
            XCTFail("Expected video intent for assistant message")
        }
    }
}
