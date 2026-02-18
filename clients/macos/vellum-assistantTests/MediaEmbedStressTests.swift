import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MediaEmbedStressTests: XCTestCase {

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

    // MARK: - No artificial cap on image embeds

    func testFiftyImageURLsProducesFiftyImageIntents() async {
        let urls = (0..<50).map { "https://cdn.example.com/img\($0).png" }
        let text = urls.joined(separator: "\n")
        let message = makeMessage(text)
        let result = await MediaEmbedResolver.resolve(
            message: message,
            settings: enabledSettings()
        )

        // Every URL should produce an image intent — no hard cap.
        XCTAssertEqual(result.count, 50, "Expected 50 image intents, got \(result.count)")
        for intent in result {
            if case .image = intent {
                // expected
            } else {
                XCTFail("Expected all intents to be images")
            }
        }
    }

    // MARK: - Video intent count

    func testTwentyVideoURLsProducesCorrectCount() async {
        let urls = (0..<20).map { "https://www.youtube.com/watch?v=vid\($0)" }
        let text = urls.joined(separator: "\n")
        let message = makeMessage(text)
        let result = await MediaEmbedResolver.resolve(
            message: message,
            settings: enabledSettings()
        )

        XCTAssertEqual(result.count, 20, "Expected 20 video intents, got \(result.count)")
        for (i, intent) in result.enumerated() {
            if case .video(let provider, let videoID, _) = intent {
                XCTAssertEqual(provider, "youtube")
                XCTAssertEqual(videoID, "vid\(i)")
            } else {
                XCTFail("Expected video intent at index \(i)")
            }
        }
    }

    // MARK: - Large mixed URL set doesn't crash

    func testOneHundredMixedURLsProcessesWithoutCrashing() async {
        var lines: [String] = []
        for i in 0..<100 {
            switch i % 3 {
            case 0:
                lines.append("https://cdn.example.com/photo\(i).jpg")
            case 1:
                lines.append("https://www.youtube.com/watch?v=mix\(i)")
            default:
                lines.append("https://vimeo.com/\(1000 + i)")
            }
        }
        let text = lines.joined(separator: " ")
        let message = makeMessage(text)

        // Should not crash; just verify we get a non-empty result.
        let result = await MediaEmbedResolver.resolve(
            message: message,
            settings: enabledSettings()
        )
        XCTAssertEqual(result.count, 100, "Expected 100 intents for 100 distinct URLs")
    }

    // MARK: - Very long text with embedded URLs

    func testVeryLongTextWithEmbeddedURLsExtractsCorrectly() async {
        // Build a message over 10,000 characters with URLs scattered throughout.
        let filler = String(repeating: "Lorem ipsum dolor sit amet. ", count: 200)
        let url1 = "https://cdn.example.com/longtext1.png"
        let url2 = "https://cdn.example.com/longtext2.jpg"
        let url3 = "https://www.youtube.com/watch?v=longvid"
        let text = filler + url1 + " " + filler + url2 + " " + filler + url3

        XCTAssertGreaterThan(text.count, 10_000, "Test text should exceed 10k chars")

        let message = makeMessage(text)
        let result = await MediaEmbedResolver.resolve(
            message: message,
            settings: enabledSettings()
        )

        XCTAssertEqual(result.count, 3, "Expected 3 intents from long text")

        // Verify types.
        let imageCount = result.filter {
            if case .image = $0 { return true }
            return false
        }.count
        let videoCount = result.filter {
            if case .video = $0 { return true }
            return false
        }.count
        XCTAssertEqual(imageCount, 2)
        XCTAssertEqual(videoCount, 1)
    }

    // MARK: - Duplicate URL deduplication

    func testDuplicateURLsAreDeduplicatedProperly() async {
        // Repeat the same image URL 10 times.
        let repeatedImage = (0..<10).map { _ in "https://cdn.example.com/same.png" }
        // Repeat the same video URL 5 times.
        let repeatedVideo = (0..<5).map { _ in "https://www.youtube.com/watch?v=dup1" }
        let text = (repeatedImage + repeatedVideo).joined(separator: "\n")
        let message = makeMessage(text)
        let result = await MediaEmbedResolver.resolve(
            message: message,
            settings: enabledSettings()
        )

        // Should deduplicate to exactly 2 intents: 1 image + 1 video.
        XCTAssertEqual(result.count, 2, "Duplicates should be collapsed to 2 unique intents")
    }

    // MARK: - URLs in various formats all resolve

    func testURLsInVariousFormatsAllResolve() async {
        let text = """
        Plain URL: https://cdn.example.com/plain.png
        Markdown link: [click here](https://cdn.example.com/markdown.jpg)
        Mixed with text https://cdn.example.com/inline.gif end of line
        """
        let message = makeMessage(text)
        let result = await MediaEmbedResolver.resolve(
            message: message,
            settings: enabledSettings()
        )

        XCTAssertEqual(result.count, 3, "All three format variants should produce intents")
        for intent in result {
            if case .image = intent {
                // expected
            } else {
                XCTFail("Expected all intents to be images")
            }
        }
    }

    // MARK: - Performance: 100 URLs under 1 second

    func testPerformanceResolverCompletesFor100URLsInReasonableTime() async {
        var lines: [String] = []
        for i in 0..<100 {
            if i % 2 == 0 {
                lines.append("https://cdn.example.com/perf\(i).png")
            } else {
                lines.append("https://www.youtube.com/watch?v=perf\(i)")
            }
        }
        let text = lines.joined(separator: "\n")
        let message = makeMessage(text)
        let settings = enabledSettings()

        let start = CFAbsoluteTimeGetCurrent()
        let result = await MediaEmbedResolver.resolve(message: message, settings: settings)
        let elapsed = CFAbsoluteTimeGetCurrent() - start

        XCTAssertEqual(result.count, 100)
        XCTAssertLessThan(
            elapsed, 1.0,
            "Resolver should complete 100 URLs in under 1 second, took \(elapsed)s"
        )
    }

    // MARK: - Deterministic output

    func testURLExtractionFromLargeTextIsDeterministic() async {
        var lines: [String] = []
        for i in 0..<50 {
            lines.append("https://cdn.example.com/det\(i).png")
        }
        let text = lines.joined(separator: " some filler text ")
        let message = makeMessage(text)
        let settings = enabledSettings()

        // Run resolution multiple times and verify identical output.
        let first = await MediaEmbedResolver.resolve(message: message, settings: settings)
        for run in 1...5 {
            let again = await MediaEmbedResolver.resolve(message: message, settings: settings)
            XCTAssertEqual(
                first, again,
                "Run \(run): resolver output should be deterministic"
            )
        }
    }
}
