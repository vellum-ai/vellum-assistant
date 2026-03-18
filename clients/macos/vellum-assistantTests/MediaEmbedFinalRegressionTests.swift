import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Comprehensive regression suite covering the complete inline media embed
/// pipeline end-to-end. Each test verifies one specific behavior built
/// across the 41 preceding PRs.
@MainActor
final class MediaEmbedFinalRegressionTests: XCTestCase {

    // MARK: - Helpers

    private func makeMessage(
        _ text: String,
        role: ChatRole = .assistant,
        timestamp: Date = Date()
    ) -> ChatMessage {
        ChatMessage(role: role, text: text, timestamp: timestamp)
    }

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

    // MARK: - Complete YouTube embed pipeline

    func testCompleteYouTubePipeline() async {
        let text = "Check this out: https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        let message = makeMessage(text)
        let intents = await MediaEmbedResolver.resolve(message: message, settings: enabledSettings())

        XCTAssertEqual(intents.count, 1)
        guard case .video(let provider, let videoID, let embedURL) = intents.first else {
            return XCTFail("Expected video intent")
        }
        XCTAssertEqual(provider, "youtube")
        XCTAssertEqual(videoID, "dQw4w9WgXcQ")
        XCTAssertEqual(embedURL.absoluteString, "https://www.youtube.com/embed/dQw4w9WgXcQ")
    }

    // MARK: - Complete Vimeo embed pipeline

    func testCompleteVimeoPipeline() async {
        let text = "Great video: https://vimeo.com/76979871"
        let message = makeMessage(text)
        let intents = await MediaEmbedResolver.resolve(message: message, settings: enabledSettings())

        XCTAssertEqual(intents.count, 1)
        guard case .video(let provider, let videoID, let embedURL) = intents.first else {
            return XCTFail("Expected video intent")
        }
        XCTAssertEqual(provider, "vimeo")
        XCTAssertEqual(videoID, "76979871")
        XCTAssertEqual(embedURL.absoluteString, "https://player.vimeo.com/video/76979871")
    }

    // MARK: - Complete Loom embed pipeline

    func testCompleteLoomPipeline() async {
        let text = "See my recording: https://www.loom.com/share/abc123def456"
        let message = makeMessage(text)
        let intents = await MediaEmbedResolver.resolve(message: message, settings: enabledSettings())

        XCTAssertEqual(intents.count, 1)
        guard case .video(let provider, let videoID, let embedURL) = intents.first else {
            return XCTFail("Expected video intent")
        }
        XCTAssertEqual(provider, "loom")
        XCTAssertEqual(videoID, "abc123def456")
        XCTAssertEqual(embedURL.absoluteString, "https://www.loom.com/embed/abc123def456")
    }

    // MARK: - Complete image embed pipeline

    func testCompleteImagePipeline() async {
        let text = "Screenshot: https://cdn.example.com/screenshot.png"
        let message = makeMessage(text)
        let intents = await MediaEmbedResolver.resolve(message: message, settings: enabledSettings())

        XCTAssertEqual(intents.count, 1)
        guard case .image(let url) = intents.first else {
            return XCTFail("Expected image intent")
        }
        XCTAssertEqual(url.absoluteString, "https://cdn.example.com/screenshot.png")
    }

    // MARK: - Settings toggle OFF disables all embeds

    func testSettingsToggleOffDisablesAllEmbeds() async {
        let text = "https://www.youtube.com/watch?v=abc123 https://cdn.example.com/photo.jpg"
        let message = makeMessage(text)
        let intents = await MediaEmbedResolver.resolve(message: message, settings: disabledSettings())

        XCTAssertEqual(intents, [], "No embeds should resolve when the feature is disabled")
    }

    // MARK: - Settings toggle ON with fresh enabledSince

    func testSettingsToggleOnWithFreshEnabledSince() async {
        let enabledMoment = Date()
        let futureMessage = makeMessage(
            "https://www.youtube.com/watch?v=future1",
            timestamp: enabledMoment.addingTimeInterval(5)
        )
        let pastMessage = makeMessage(
            "https://www.youtube.com/watch?v=past1",
            timestamp: enabledMoment.addingTimeInterval(-60)
        )
        let settings = enabledSettings(enabledSince: enabledMoment)

        let futureIntents = await MediaEmbedResolver.resolve(message: futureMessage, settings: settings)
        let pastIntents = await MediaEmbedResolver.resolve(message: pastMessage, settings: settings)

        XCTAssertEqual(futureIntents.count, 1, "Messages after enabledSince should resolve")
        XCTAssertEqual(pastIntents.count, 0, "Messages before enabledSince should be gated out")
    }

    // MARK: - Domain allowlist modification (add/remove domain)

    func testDomainAllowlistAddRemove() {
        let youtubeURL = URL(string: "https://www.youtube.com/watch?v=test1")!

        // When youtube.com is allowed
        XCTAssertTrue(
            DomainAllowlistMatcher.isAllowed(youtubeURL, allowedDomains: ["youtube.com"]),
            "URL should match when its domain is in the allowlist"
        )

        // When youtube.com is removed from allowlist
        XCTAssertFalse(
            DomainAllowlistMatcher.isAllowed(youtubeURL, allowedDomains: ["vimeo.com", "loom.com"]),
            "URL should not match when its domain is absent from the allowlist"
        )

        // Re-add youtube.com
        XCTAssertTrue(
            DomainAllowlistMatcher.isAllowed(youtubeURL, allowedDomains: ["vimeo.com", "youtube.com"]),
            "URL should match again after re-adding its domain"
        )
    }

    // MARK: - Code block exclusion

    func testCodeBlockExclusionStillWorks() async {
        let text = """
        Here is a fenced block:
        ```
        https://www.youtube.com/watch?v=inside_code
        ```
        And inline code: `https://vimeo.com/12345678`
        """
        let message = makeMessage(text)
        let intents = await MediaEmbedResolver.resolve(message: message, settings: enabledSettings())

        XCTAssertEqual(intents, [], "URLs inside code regions must be excluded")
    }

    // MARK: - Markdown link extraction

    func testMarkdownLinkExtraction() {
        let text = "Check [this video](https://www.youtube.com/watch?v=md123) for details."
        let urls = MessageURLExtractor.extractMarkdownLinkURLs(from: text)

        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://www.youtube.com/watch?v=md123")
    }

    // MARK: - Deduplication across plain and markdown URLs

    func testDeduplicationAcrossPlainAndMarkdownURLs() {
        let sharedURL = "https://www.youtube.com/watch?v=dedup1"
        let text = "\(sharedURL) and also [link](\(sharedURL))"
        let urls = MessageURLExtractor.extractAllURLs(from: text)

        XCTAssertEqual(urls.count, 1, "Duplicate URL from both plain and markdown should appear once")
        XCTAssertEqual(urls.first?.absoluteString, sharedURL)
    }

    // MARK: - User and assistant messages both produce embeds

    func testUserMessageProducesEmbeds() async {
        let message = makeMessage("https://vimeo.com/11111111", role: .user)
        let intents = await MediaEmbedResolver.resolve(message: message, settings: enabledSettings())

        XCTAssertEqual(intents.count, 1)
        if case .video(let provider, _, _) = intents.first {
            XCTAssertEqual(provider, "vimeo")
        } else {
            XCTFail("Expected video intent for user message")
        }
    }

    func testAssistantMessageProducesEmbeds() async {
        let message = makeMessage("https://vimeo.com/22222222", role: .assistant)
        let intents = await MediaEmbedResolver.resolve(message: message, settings: enabledSettings())

        XCTAssertEqual(intents.count, 1)
        if case .video(let provider, _, _) = intents.first {
            XCTAssertEqual(provider, "vimeo")
        } else {
            XCTFail("Expected video intent for assistant message")
        }
    }

    // MARK: - Multiple providers in single message

    func testMultipleProvidersInSingleMessage() async {
        let text = """
        YouTube: https://www.youtube.com/watch?v=yt1 \
        Vimeo: https://vimeo.com/33333333 \
        Loom: https://www.loom.com/share/loom1 \
        Image: https://cdn.example.com/pic.webp
        """
        let message = makeMessage(text)
        let intents = await MediaEmbedResolver.resolve(message: message, settings: enabledSettings())

        XCTAssertEqual(intents.count, 4, "Should resolve one intent per distinct embeddable URL")

        // Verify each provider is represented
        let providers = intents.compactMap { intent -> String? in
            switch intent {
            case .video(let provider, _, _): return provider
            case .image: return "image"
            }
        }
        XCTAssertTrue(providers.contains("youtube"))
        XCTAssertTrue(providers.contains("vimeo"))
        XCTAssertTrue(providers.contains("loom"))
        XCTAssertTrue(providers.contains("image"))
    }

    // MARK: - InlineVideoEmbedStateManager full lifecycle

    func testInlineVideoEmbedStateManagerFullLifecycle() {
        let manager = InlineVideoEmbedStateManager()

        // Starts at placeholder
        XCTAssertEqual(manager.state, .placeholder)

        // Play request transitions to initializing
        manager.requestPlay()
        XCTAssertEqual(manager.state, .initializing)

        // Playback begins
        manager.didStartPlaying()
        XCTAssertEqual(manager.state, .playing)

        // Reset returns to placeholder
        manager.reset()
        XCTAssertEqual(manager.state, .placeholder)

        // Failure path: placeholder -> initializing -> failed -> initializing (retry)
        manager.requestPlay()
        XCTAssertEqual(manager.state, .initializing)

        manager.didFail("Load error")
        XCTAssertEqual(manager.state, .failed("Load error"))

        manager.requestPlay()
        XCTAssertEqual(manager.state, .initializing, "Retry from failed should transition to initializing")

        // Idempotent: requestPlay from initializing is a no-op
        manager.requestPlay()
        XCTAssertEqual(manager.state, .initializing)

        // Idempotent: requestPlay from playing is a no-op
        manager.didStartPlaying()
        manager.requestPlay()
        XCTAssertEqual(manager.state, .playing)
    }

    // MARK: - VideoEmbedURLBuilder produces correct autoplay URLs

    func testVideoEmbedURLBuilderYouTube() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "youtube", videoID: "abc123")
        XCTAssertEqual(url?.absoluteString, "https://www.youtube.com/embed/abc123?autoplay=1&rel=0&playsinline=1")
    }

    func testVideoEmbedURLBuilderVimeo() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "vimeo", videoID: "99999999")
        XCTAssertEqual(url?.absoluteString, "https://player.vimeo.com/video/99999999?autoplay=1")
    }

    func testVideoEmbedURLBuilderLoom() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "loom", videoID: "deadbeef")
        XCTAssertEqual(url?.absoluteString, "https://www.loom.com/embed/deadbeef?autoplay=1")
    }

    func testVideoEmbedURLBuilderUnknownProvider() {
        let url = VideoEmbedURLBuilder.buildEmbedURL(provider: "dailymotion", videoID: "xyz")
        XCTAssertNil(url, "Unknown providers should return nil")
    }

    // MARK: - DomainAllowlistMatcher subdomain matching

    func testDomainAllowlistMatcherSubdomainMatching() {
        let url = URL(string: "https://www.youtube.com/watch?v=sub1")!

        // "youtube.com" should match "www.youtube.com"
        XCTAssertTrue(
            DomainAllowlistMatcher.isAllowed(url, allowedDomains: ["youtube.com"]),
            "Subdomain www.youtube.com should match allowlist entry youtube.com"
        )
    }

    func testDomainAllowlistMatcherExactMatch() {
        let url = URL(string: "https://vimeo.com/12345678")!

        XCTAssertTrue(
            DomainAllowlistMatcher.isAllowed(url, allowedDomains: ["vimeo.com"]),
            "Exact host match should pass"
        )
    }

    func testDomainAllowlistMatcherRejectsNonHTTPS() {
        let url = URL(string: "http://www.youtube.com/watch?v=http1")!

        XCTAssertFalse(
            DomainAllowlistMatcher.isAllowed(url, allowedDomains: ["youtube.com"]),
            "Non-HTTPS URLs should be rejected by the matcher"
        )
    }

    func testDomainAllowlistMatcherRejectsUnlistedDomain() {
        let url = URL(string: "https://evil.com/watch?v=malicious")!

        XCTAssertFalse(
            DomainAllowlistMatcher.isAllowed(url, allowedDomains: ["youtube.com", "vimeo.com"]),
            "Unlisted domains should be rejected"
        )
    }

    // MARK: - ImageURLClassifier for all common extensions

    func testImageURLClassifierCommonExtensions() {
        let extensions = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tiff", "tif", "avif", "heic"]

        for ext in extensions {
            let url = URL(string: "https://cdn.example.com/image.\(ext)")!
            let result = ImageURLClassifier.classify(url)
            XCTAssertEqual(result, .image, "Extension .\(ext) should classify as .image")
        }
    }

    func testImageURLClassifierNonImageExtension() {
        let url = URL(string: "https://cdn.example.com/document.pdf")!
        let result = ImageURLClassifier.classify(url)
        XCTAssertEqual(result, .notImage, ".pdf should classify as .notImage")
    }

    func testImageURLClassifierNoExtension() {
        let url = URL(string: "https://cdn.example.com/resource")!
        let result = ImageURLClassifier.classify(url)
        XCTAssertEqual(result, .unknown, "URL without extension should classify as .unknown")
    }

    func testImageURLClassifierRejectsHTTP() {
        let url = URL(string: "http://cdn.example.com/image.png")!
        let result = ImageURLClassifier.classify(url)
        XCTAssertEqual(result, .notImage, "HTTP URLs should classify as .notImage for security")
    }
}
