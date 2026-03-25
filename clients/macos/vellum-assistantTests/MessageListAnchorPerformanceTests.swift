import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

// MARK: - MessageListView Anchor & Rendering Performance Baselines
//
// These tests establish XCTest performance baselines for:
//   1. MessageListScrollCoordinator anchor hot-path stress (called on every scroll frame)
//   2. Large conversation markdown pipeline throughput (cold cache)
//   3. Attributed string cache hit performance (hot cache)
//
// Run manually with:
//   swift test --filter MessageListAnchorPerformanceTests  (from clients/macos/)
// or via Xcode's Test navigator.

@MainActor
final class MessageListAnchorPerformanceTests: XCTestCase {

    // MARK: - Sample Data

    // Realistic markdown similar to MarkdownPerformanceTests — used to build
    // a 50-message conversation with alternating user/assistant messages.
    private static let sampleAssistantMarkdown: String = """
    # Getting Started with Swift Concurrency

    Swift 5.5 introduced structured concurrency — a model that makes asynchronous \
    code as readable as synchronous code.  At its core are two primitives: \
    `async`/`await` and `Task`.

    ## Why Structured Concurrency?

    Before Swift 5.5, asynchronous work was expressed through completion handlers, \
    combine pipelines, or DispatchQueue callbacks.  These approaches are hard to \
    reason about, especially when multiple asynchronous operations depend on each \
    other.

    Structured concurrency solves this by tying the lifetime of every child task to \
    a parent scope.  When the parent scope exits, all child tasks are automatically \
    cancelled and awaited.

    ## Core APIs

    ### async / await

    Mark a function `async` to indicate it can suspend:

    ```swift
    func fetchUser(id: String) async throws -> User {
        let url = URL(string: "https://api.example.com/users/\\(id)")!
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(User.self, from: data)
    }
    ```

    - Audit every `DispatchQueue.async` call and determine whether it can become `await`
    - Replace `DispatchGroup` fan-out patterns with `withTaskGroup`
    - Mark view models and data-layer types with `@MainActor` where appropriate

    | Approach            | Cancellation | Structured | Readable |
    |---------------------|:------------:|:----------:|:--------:|
    | Completion handlers | Manual       | No         | Low      |
    | async/await         | Automatic    | Yes        | High     |
    """

    private static let sampleUserMarkdown: String = """
    Can you explain how `Task.sleep(nanoseconds:)` works and when I should use \
    `Task.checkCancellation()` vs `Task.isCancelled`?

    I'm also curious about `TaskLocal` — when would I use that instead of a \
    regular property on an actor?

    ```swift
    let task = Task {
        try await Task.sleep(nanoseconds: 1_000_000_000)
        print("Done")
    }
    task.cancel()
    ```
    """

    // MARK: - 1. Coordinator Anchor Rapid-Update Stress Test

    /// Benchmarks calling updateAnchor(distanceFromBottom:viewportHeight:) and
    /// updateIsAtBottom() 10,000 times in a
    /// tight loop. While individually trivial (O(1)), they are called on EVERY
    /// scroll frame. This test detects if any future refactoring adds overhead.
    func testBottomDetectionRapidUpdateStress() {
        let coordinator = MessageListScrollCoordinator()

        measure(metrics: [XCTClockMetric(), XCTCPUMetric()]) {
            for i in 0..<10_000 {
                // Simulate scroll position changes: alternate between bottom
                // anchor and other views to stress isAtBottom updates.
                let viewID: String? = i % 10 == 0 ? "scroll-bottom-anchor" : "message-\(i)"
                coordinator.updateIsAtBottom(viewID)
            }
        }
    }

    // MARK: - 2. Large Conversation Markdown Pipeline Throughput

    /// Builds 50 alternating user/assistant messages and measures the full
    /// parse + group + build attributed string pipeline. This simulates the
    /// work done when scrolling through a large conversation where the
    /// attributed string cache is cold.
    func testLargeConversationMarkdownPipelineThroughput() {
        // Build 50 messages alternating user/assistant content.
        let messages: [String] = (0..<50).map { i in
            i.isMultiple(of: 2) ? Self.sampleUserMarkdown : Self.sampleAssistantMarkdown
        }

        measure(metrics: [XCTClockMetric(), XCTCPUMetric()]) {
            for markdown in messages {
                let segments = parseMarkdownSegments(markdown)
                let groups = groupSegments(segments)
                for group in groups {
                    if case .selectableRun(let run) = group {
                        _ = makeAttributedString(from: run)
                    }
                }
            }
        }
    }

    // MARK: - 3. Attributed String Cache Hit Performance

    /// Pre-warms a set of parsed segments, then measures how fast 200
    /// repeated cache lookups are. This benchmarks the LRU cache hot path
    /// using the same makeAttributedString helper (which mirrors the real
    /// cache-less build path from MarkdownPerformanceTests).
    ///
    /// Because the real MarkdownSegmentView cache is private and requires a
    /// SwiftUI view instance, we benchmark the attributed string construction
    /// path with a local dictionary cache to validate that caching itself
    /// does not regress.
    func testAttributedStringCacheHitPerformance() {
        // Parse a representative set of segments once.
        let markdowns = [Self.sampleAssistantMarkdown, Self.sampleUserMarkdown]
        let allRuns: [[MarkdownSegment]] = markdowns.flatMap { md -> [[MarkdownSegment]] in
            let segments = parseMarkdownSegments(md)
            let groups = groupSegments(segments)
            return groups.compactMap { group -> [MarkdownSegment]? in
                if case .selectableRun(let run) = group { return run }
                return nil
            }
        }

        // Pre-warm: build each attributed string once and store in a local cache.
        var cache: [Int: AttributedString] = [:]
        for (index, run) in allRuns.enumerated() {
            cache[index] = makeAttributedString(from: run)
        }

        // Measure 200 repeated cache lookups.
        measure(metrics: [XCTClockMetric(), XCTCPUMetric()]) {
            for _ in 0..<200 {
                for (index, _) in allRuns.enumerated() {
                    _ = cache[index]
                }
            }
        }
    }
}

// MARK: - Test Helpers (shared with MarkdownPerformanceTests)

/// Mirrors `MarkdownSegmentView.computeGroupedSegments()` — duplicated here
/// as a pure function so the performance test can call it without constructing
/// a SwiftUI view.
private enum SegmentGroup {
    case selectableRun([MarkdownSegment])
    case heading(level: Int, text: String)
    case codeBlock(language: String?, code: String)
    case list(items: [MarkdownListItem], ordered: Bool)
    case table(headers: [String], rows: [[String]])
    case image(alt: String, url: String)
    case horizontalRule
}

private func groupSegments(_ segments: [MarkdownSegment]) -> [SegmentGroup] {
    var groups: [SegmentGroup] = []
    var currentRun: [MarkdownSegment] = []

    func flushRun() {
        if !currentRun.isEmpty {
            groups.append(.selectableRun(currentRun))
            currentRun = []
        }
    }

    for segment in segments {
        switch segment {
        case .text:
            currentRun.append(segment)
        case .heading(let level, let text):
            flushRun()
            groups.append(.heading(level: level, text: text))
        case .list(let items):
            flushRun()
            let hasOrdered = items.contains { $0.ordered }
            groups.append(.list(items: items, ordered: hasOrdered))
        case .codeBlock(let language, let code):
            flushRun()
            groups.append(.codeBlock(language: language, code: code))
        case .table(let headers, let rows):
            flushRun()
            groups.append(.table(headers: headers, rows: rows))
        case .image(let alt, let url):
            flushRun()
            groups.append(.image(alt: alt, url: url))
        case .horizontalRule:
            flushRun()
            groups.append(.horizontalRule)
        }
    }
    flushRun()
    return groups
}

/// Builds a combined `AttributedString` from a selectable run by parsing each
/// text segment's inline markdown. Mirrors the hot path in
/// `MarkdownSegmentView.buildAttributedStringUncached(from:…)`.
private func makeAttributedString(from segments: [MarkdownSegment]) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .inlineOnlyPreservingWhitespace
    )
    var result = AttributedString()
    for (index, segment) in segments.enumerated() {
        if index > 0 {
            result += AttributedString("\n\n")
        }
        if case .text(let text) = segment {
            let attributed = (try? AttributedString(markdown: text, options: options))
                ?? AttributedString(text)
            result += attributed
        }
    }

    // Apply background, text color, and padding to inline code spans —
    // mirrors the pass in buildAttributedStringUncached.
    var codeRanges: [Range<AttributedString.Index>] = []
    for run in result.runs {
        if let intent = run.inlinePresentationIntent, intent.contains(.code) {
            codeRanges.append(run.range)
        }
    }
    for range in codeRanges.reversed() {
        result[range].foregroundColor = VColor.systemNegativeStrong
        result[range].backgroundColor = VColor.surfaceActive
        var trailing = AttributedString("\u{2009}")
        trailing.backgroundColor = VColor.surfaceActive
        result.insert(trailing, at: range.upperBound)
        var leading = AttributedString("\u{2009}")
        leading.backgroundColor = VColor.surfaceActive
        result.insert(leading, at: range.lowerBound)
    }

    return result
}
