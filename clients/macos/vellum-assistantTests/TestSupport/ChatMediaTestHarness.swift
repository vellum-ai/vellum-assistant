import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

// MARK: - Test Fixtures

/// Reusable URL fixtures for media embed testing across PRs 04-42.
/// Each fixture provides a representative URL for a specific media provider
/// or content type, along with surrounding prose to simulate realistic messages.
enum MediaFixtures {

    // MARK: YouTube

    static let youtubeStandard = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    static let youtubeShort = "https://youtu.be/dQw4w9WgXcQ"
    static let youtubeEmbed = "https://www.youtube.com/embed/dQw4w9WgXcQ"
    static let youtubeShorts = "https://www.youtube.com/shorts/dQw4w9WgXcQ"

    // MARK: Vimeo

    static let vimeoStandard = "https://vimeo.com/123456789"
    static let vimeoPlayer = "https://player.vimeo.com/video/123456789"

    // MARK: Loom

    static let loomShare = "https://www.loom.com/share/abc123def456"
    static let loomEmbed = "https://www.loom.com/embed/abc123def456"

    // MARK: Image URLs

    static let imagePNG = "https://example.com/photo.png"
    static let imageJPG = "https://example.com/chart.jpg"
    static let imageGIF = "https://example.com/animation.gif"
    static let imageWebP = "https://example.com/modern.webp"
    static let imageSVG = "https://example.com/diagram.svg"

    // MARK: Non-embeddable URLs (should never trigger embed behavior)

    static let plainHTTPS = "https://example.com/page"
    static let githubRepo = "https://github.com/vellum-ai/vellum-assistant"
    static let docsPage = "https://docs.swift.org/swift-book/"

    // MARK: Message templates

    /// An assistant message containing a single YouTube link surrounded by prose.
    static func assistantMessageWithYouTube(url: String = youtubeStandard) -> ChatMessage {
        ChatMessage(role: .assistant, text: "Here is a video tutorial: \(url) -- hope it helps!")
    }

    /// A user message containing a single YouTube link.
    static func userMessageWithYouTube(url: String = youtubeStandard) -> ChatMessage {
        ChatMessage(role: .user, text: "Check this out: \(url)")
    }

    /// An assistant message containing a Vimeo link.
    static func assistantMessageWithVimeo(url: String = vimeoStandard) -> ChatMessage {
        ChatMessage(role: .assistant, text: "Watch this presentation: \(url)")
    }

    /// An assistant message containing a Loom link.
    static func assistantMessageWithLoom(url: String = loomShare) -> ChatMessage {
        ChatMessage(role: .assistant, text: "Here's my recording: \(url)")
    }

    /// An assistant message containing an image URL.
    static func assistantMessageWithImage(url: String = imagePNG) -> ChatMessage {
        ChatMessage(role: .assistant, text: "Here's the diagram: \(url)")
    }

    /// An assistant message containing multiple media URLs of different types.
    static func assistantMessageWithMixedMedia() -> ChatMessage {
        ChatMessage(role: .assistant, text: """
            Here are some resources:
            - Video: \(youtubeStandard)
            - Presentation: \(vimeoStandard)
            - Recording: \(loomShare)
            - Diagram: \(imagePNG)
            """)
    }

    /// A user message containing a mix of embeddable and plain URLs.
    static func userMessageWithMixedURLs() -> ChatMessage {
        ChatMessage(role: .user, text: """
            Links: \(youtubeStandard) and \(plainHTTPS) and \(imageJPG)
            """)
    }

    /// A message with markdown-formatted links (e.g. `[text](url)`).
    static func assistantMessageWithMarkdownLinks() -> ChatMessage {
        ChatMessage(role: .assistant, text: """
            Check [this video](\(youtubeStandard)) and [this image](\(imagePNG)).
            """)
    }

    /// An assistant message with no URLs at all.
    static func assistantMessagePlainText() -> ChatMessage {
        ChatMessage(role: .assistant, text: "This message has no links at all.")
    }

    /// All video fixture URLs for iteration in parameterized-style tests.
    static let allVideoURLs: [String] = [
        youtubeStandard, youtubeShort, youtubeEmbed, youtubeShorts,
        vimeoStandard, vimeoPlayer,
        loomShare, loomEmbed,
    ]

    /// All image fixture URLs for iteration in parameterized-style tests.
    static let allImageURLs: [String] = [
        imagePNG, imageJPG, imageGIF, imageWebP, imageSVG,
    ]

    /// URLs that should never trigger any embed behavior.
    static let nonEmbeddableURLs: [String] = [
        plainHTTPS, githubRepo, docsPage,
    ]
}

// MARK: - Assertion Helpers

/// Lightweight assertion helpers for media embed tests.
/// These keep individual test methods concise and consistent.
enum ChatMediaAssertions {

    /// Asserts that the message text contains the given URL string verbatim.
    static func assertContainsLinkText(
        _ url: String,
        in message: ChatMessage,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertTrue(
            message.text.contains(url),
            "Expected message text to contain URL \"\(url)\" but got: \"\(message.text)\"",
            file: file,
            line: line
        )
    }

    /// Asserts that the message has an inline surface whose ID contains the
    /// given URL, indicating an embed intent for that specific resource.
    static func assertContainsEmbedIntent(
        _ url: String,
        in message: ChatMessage,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let match = message.inlineSurfaces.contains { surface in
            surface.id.contains(url)
        }
        XCTAssertTrue(
            match,
            "Expected an inline surface with ID containing URL \"\(url)\" but found: \(message.inlineSurfaces.map(\.id))",
            file: file,
            line: line
        )
    }

    /// Asserts that the message has no embed-related side effects:
    /// no inline surfaces, no synthesized attachments, no synthesized tool calls.
    static func assertContainsNoEmbedIntent(
        in message: ChatMessage,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertTrue(
            message.inlineSurfaces.isEmpty,
            "Expected no inline surfaces (embed intents) but found \(message.inlineSurfaces.count)",
            file: file,
            line: line
        )
        XCTAssertTrue(
            message.attachments.isEmpty,
            "Expected no synthesized attachments but found \(message.attachments.count)",
            file: file,
            line: line
        )
        XCTAssertTrue(
            message.toolCalls.isEmpty,
            "Expected no synthesized tool calls but found \(message.toolCalls.count)",
            file: file,
            line: line
        )
    }

    /// Asserts that the message role matches the expected role.
    static func assertRole(
        _ expected: ChatRole,
        in message: ChatMessage,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(
            message.role, expected,
            "Expected role .\(expected) but got .\(message.role)",
            file: file,
            line: line
        )
    }
}

// MARK: - Harness Self-Tests

/// Validates the test harness itself: fixtures produce valid messages and
/// assertion helpers behave correctly. Run these first so later PRs can
/// trust the harness unconditionally.
@MainActor
final class ChatMediaTestHarnessTests: XCTestCase {

    // MARK: Fixture construction

    func testFixtureAssistantYouTubeMessageContainsURL() {
        let msg = MediaFixtures.assistantMessageWithYouTube()
        ChatMediaAssertions.assertContainsLinkText(MediaFixtures.youtubeStandard, in: msg)
        ChatMediaAssertions.assertRole(.assistant, in: msg)
    }

    func testFixtureUserYouTubeMessageContainsURL() {
        let msg = MediaFixtures.userMessageWithYouTube()
        ChatMediaAssertions.assertContainsLinkText(MediaFixtures.youtubeStandard, in: msg)
        ChatMediaAssertions.assertRole(.user, in: msg)
    }

    func testFixtureVimeoMessageContainsURL() {
        let msg = MediaFixtures.assistantMessageWithVimeo()
        ChatMediaAssertions.assertContainsLinkText(MediaFixtures.vimeoStandard, in: msg)
    }

    func testFixtureLoomMessageContainsURL() {
        let msg = MediaFixtures.assistantMessageWithLoom()
        ChatMediaAssertions.assertContainsLinkText(MediaFixtures.loomShare, in: msg)
    }

    func testFixtureImageMessageContainsURL() {
        let msg = MediaFixtures.assistantMessageWithImage()
        ChatMediaAssertions.assertContainsLinkText(MediaFixtures.imagePNG, in: msg)
    }

    func testFixtureMixedMediaContainsAllURLs() {
        let msg = MediaFixtures.assistantMessageWithMixedMedia()
        ChatMediaAssertions.assertContainsLinkText(MediaFixtures.youtubeStandard, in: msg)
        ChatMediaAssertions.assertContainsLinkText(MediaFixtures.vimeoStandard, in: msg)
        ChatMediaAssertions.assertContainsLinkText(MediaFixtures.loomShare, in: msg)
        ChatMediaAssertions.assertContainsLinkText(MediaFixtures.imagePNG, in: msg)
    }

    func testFixtureMarkdownLinksContainURLs() {
        let msg = MediaFixtures.assistantMessageWithMarkdownLinks()
        ChatMediaAssertions.assertContainsLinkText(MediaFixtures.youtubeStandard, in: msg)
        ChatMediaAssertions.assertContainsLinkText(MediaFixtures.imagePNG, in: msg)
    }

    func testFixturePlainTextMessageHasNoURLs() {
        let msg = MediaFixtures.assistantMessagePlainText()
        XCTAssertFalse(msg.text.contains("http"),
                       "Plain text fixture should not contain any URLs")
    }

    // MARK: Assertion helpers — no-embed baseline

    func testAssertNoEmbedIntentPassesForPlainMessages() {
        let msg = MediaFixtures.assistantMessageWithYouTube()
        // Currently no embed behavior exists, so this should pass
        ChatMediaAssertions.assertContainsNoEmbedIntent(in: msg)
    }

    func testAssertNoEmbedIntentPassesForAllVideoFixtures() {
        for url in MediaFixtures.allVideoURLs {
            let msg = MediaFixtures.assistantMessageWithYouTube(url: url)
            ChatMediaAssertions.assertContainsLinkText(url, in: msg)
            ChatMediaAssertions.assertContainsNoEmbedIntent(in: msg)
        }
    }

    func testAssertNoEmbedIntentPassesForAllImageFixtures() {
        for url in MediaFixtures.allImageURLs {
            let msg = MediaFixtures.assistantMessageWithImage(url: url)
            ChatMediaAssertions.assertContainsLinkText(url, in: msg)
            ChatMediaAssertions.assertContainsNoEmbedIntent(in: msg)
        }
    }

    func testAssertNoEmbedIntentPassesForNonEmbeddableURLs() {
        for url in MediaFixtures.nonEmbeddableURLs {
            let msg = ChatMessage(role: .assistant, text: "See \(url)")
            ChatMediaAssertions.assertContainsLinkText(url, in: msg)
            ChatMediaAssertions.assertContainsNoEmbedIntent(in: msg)
        }
    }

    // MARK: Fixture arrays are non-empty

    func testVideoFixtureArrayIsNonEmpty() {
        XCTAssertFalse(MediaFixtures.allVideoURLs.isEmpty,
                       "allVideoURLs fixture array must not be empty")
    }

    func testImageFixtureArrayIsNonEmpty() {
        XCTAssertFalse(MediaFixtures.allImageURLs.isEmpty,
                       "allImageURLs fixture array must not be empty")
    }

    func testNonEmbeddableURLArrayIsNonEmpty() {
        XCTAssertFalse(MediaFixtures.nonEmbeddableURLs.isEmpty,
                       "nonEmbeddableURLs fixture array must not be empty")
    }
}
