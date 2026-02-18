import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Verifies lazy-initialization contracts for media embed UI components.
///
/// The inline video and image embed views defer heavyweight resource creation
/// (WKWebView, AsyncImage loads) until the user explicitly interacts or the
/// view scrolls into the visible area.  These tests assert those contracts at
/// the state-manager / model level so regressions are caught without requiring
/// a full SwiftUI host.
@MainActor
final class MediaEmbedLazyInitGuardTests: XCTestCase {

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

    // MARK: - State manager starts in placeholder

    /// A freshly created state manager must be in `.placeholder`, proving
    /// that no webview or player is allocated on construction.
    func testStateManagerStartsInPlaceholder() {
        let manager = InlineVideoEmbedStateManager()
        XCTAssertEqual(manager.state, .placeholder)
    }

    // MARK: - Bulk creation stays in placeholder

    /// Creating many state managers at once must not trigger any automatic
    /// initialization.  Every instance should remain `.placeholder`.
    func testBulkStateManagerCreation_AllStartAsPlaceholder() {
        let managers = (0..<100).map { _ in InlineVideoEmbedStateManager() }
        for (i, manager) in managers.enumerated() {
            XCTAssertEqual(
                manager.state, .placeholder,
                "Manager at index \(i) should start as .placeholder"
            )
        }
    }

    // MARK: - Only the requested manager transitions

    /// When one manager out of many calls `requestPlay()`, only that manager
    /// should move to `.initializing`.  All others must stay `.placeholder`,
    /// confirming there is no shared global state that triggers initialization.
    func testOnlyRequestedManagerTransitionsToInitializing() {
        let managers = (0..<50).map { _ in InlineVideoEmbedStateManager() }

        // Pick one manager to activate.
        let targetIndex = 25
        managers[targetIndex].requestPlay()

        for (i, manager) in managers.enumerated() {
            if i == targetIndex {
                XCTAssertEqual(
                    manager.state, .initializing,
                    "The requested manager should be .initializing"
                )
            } else {
                XCTAssertEqual(
                    manager.state, .placeholder,
                    "Manager at index \(i) should remain .placeholder"
                )
            }
        }
    }

    // MARK: - Reset returns to placeholder

    /// Walking through the full lifecycle (placeholder -> initializing ->
    /// playing -> reset) must return to `.placeholder`, proving that the
    /// heavyweight resources can be torn down.
    func testResetReturnsToPlaceholder() {
        let manager = InlineVideoEmbedStateManager()
        XCTAssertEqual(manager.state, .placeholder)

        manager.requestPlay()
        XCTAssertEqual(manager.state, .initializing)

        manager.didStartPlaying()
        XCTAssertEqual(manager.state, .playing)

        manager.reset()
        XCTAssertEqual(manager.state, .placeholder)
    }

    // MARK: - Large-scale memory footprint guard

    /// Creating 1,000 state managers must not cause any auto-initialization.
    /// This is a proxy for memory pressure: each manager in `.placeholder`
    /// holds only a trivial enum value, whereas `.initializing` or `.playing`
    /// would imply a WKWebView allocation in the real UI layer.
    func testStateManagerMemoryFootprint() {
        let managers = (0..<1_000).map { _ in InlineVideoEmbedStateManager() }
        let nonPlaceholder = managers.filter { $0.state != .placeholder }
        XCTAssertEqual(
            nonPlaceholder.count, 0,
            "All 1,000 managers should remain .placeholder; \(nonPlaceholder.count) auto-initialized"
        )
    }

    // MARK: - State machine does not auto-play

    /// Verifies the state machine's transitions are explicit and never
    /// auto-advance.  Creating a manager, then transitioning through
    /// initializing -> playing -> reset should require explicit calls
    /// at each step.
    func testVideoStateMachineDoesNotAutoPlay() {
        let manager = InlineVideoEmbedStateManager()

        // Creation must not auto-play.
        XCTAssertEqual(manager.state, .placeholder)

        // requestPlay advances to initializing, not playing.
        manager.requestPlay()
        XCTAssertEqual(
            manager.state, .initializing,
            "requestPlay() should move to .initializing, not .playing"
        )

        // A second requestPlay() while initializing is a no-op.
        manager.requestPlay()
        XCTAssertEqual(
            manager.state, .initializing,
            "Duplicate requestPlay() during .initializing should be a no-op"
        )

        // Explicit didStartPlaying() is required to reach .playing.
        manager.didStartPlaying()
        XCTAssertEqual(manager.state, .playing)

        // requestPlay() while playing is a no-op.
        manager.requestPlay()
        XCTAssertEqual(
            manager.state, .playing,
            "requestPlay() during .playing should be a no-op"
        )

        // Reset goes back to placeholder.
        manager.reset()
        XCTAssertEqual(manager.state, .placeholder)
    }

    // MARK: - Resolver performance with 200 URLs

    /// The resolver must handle 200 mixed URLs well within 2 seconds.
    /// This ensures that lazy initialization at the resolver layer (URL
    /// parsing, classification, deduplication) does not introduce
    /// unexpected latency that would block the main thread during message
    /// rendering.
    func testResolverPerformanceWith200URLs() async {
        var lines: [String] = []
        for i in 0..<200 {
            switch i % 4 {
            case 0:
                lines.append("https://cdn.example.com/photo\(i).png")
            case 1:
                lines.append("https://www.youtube.com/watch?v=perf\(i)")
            case 2:
                lines.append("https://vimeo.com/\(100_000 + i)")
            default:
                lines.append("https://cdn.example.com/image\(i).jpg")
            }
        }

        let text = lines.joined(separator: "\n")
        let message = makeMessage(text)
        let settings = enabledSettings()

        let start = CFAbsoluteTimeGetCurrent()
        let result = await MediaEmbedResolver.resolve(
            message: message,
            settings: settings
        )
        let elapsed = CFAbsoluteTimeGetCurrent() - start

        XCTAssertEqual(result.count, 200, "Expected 200 intents, got \(result.count)")
        XCTAssertLessThan(
            elapsed, 2.0,
            "Resolver should complete 200 URLs in under 2 seconds, took \(elapsed)s"
        )
    }

    // MARK: - Image classifier performance with 500 URLs

    /// The extension-based image classifier must handle 500 URLs in under
    /// 1 second.  This is the synchronous first stage of image detection,
    /// so it must be fast enough to never block the main thread.
    func testImageClassifierPerformanceWith500URLs() {
        let urls: [URL] = (0..<500).compactMap { i in
            switch i % 5 {
            case 0:  return URL(string: "https://cdn.example.com/img\(i).png")
            case 1:  return URL(string: "https://cdn.example.com/img\(i).jpg")
            case 2:  return URL(string: "https://cdn.example.com/img\(i).webp")
            case 3:  return URL(string: "https://cdn.example.com/img\(i).gif")
            default: return URL(string: "https://cdn.example.com/img\(i).svg")
            }
        }

        let start = CFAbsoluteTimeGetCurrent()
        for url in urls {
            _ = ImageURLClassifier.classify(url)
        }
        let elapsed = CFAbsoluteTimeGetCurrent() - start

        XCTAssertLessThan(
            elapsed, 1.0,
            "Image classifier should handle 500 URLs in under 1 second, took \(elapsed)s"
        )
    }
}
