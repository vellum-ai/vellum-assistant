import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

// MARK: - Markdown Pipeline Performance Baselines
//
// These tests establish XCTest performance baselines for the markdown parsing
// and segment-grouping pipeline. On the first run XCTest records a baseline;
// subsequent runs fail if CPU time regresses by more than 10 % (the
// default XCTest allowance).
//
// Run manually with:
//   swift test --filter MarkdownPerformanceTests  (from clients/macos/)
// or via Xcode's Test navigator.

final class MarkdownPerformanceTests: XCTestCase {

    // ~500-word realistic markdown document covering every segment type the
    // parser recognises: headings, paragraphs with inline code, bullet lists,
    // ordered lists, a fenced code block, a table, a horizontal rule, and a
    // markdown image.
    private static let sampleMarkdown: String = """
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

    Call it with `await` inside another `async` context:

    ```swift
    let user = try await fetchUser(id: "42")
    print(user.name)
    ```

    ### Task and TaskGroup

    A `Task` creates an unstructured concurrency unit — useful when you need to \
    bridge synchronous and asynchronous worlds:

    ```swift
    Task {
        await performBackgroundWork()
    }
    ```

    Use `withTaskGroup` when you need fan-out concurrency with a fixed result type:

    ```swift
    let results = try await withThrowingTaskGroup(of: Int.self) { group in
        for i in 0..<10 {
            group.addTask { await expensiveComputation(i) }
        }
        return try await group.reduce(0, +)
    }
    ```

    ## Actors

    Actors protect mutable state from data races.  Accessing actor-isolated \
    properties from outside the actor requires `await`:

    ```swift
    actor Counter {
        private var value = 0
        func increment() { value += 1 }
        func current() -> Int { value }
    }

    let counter = Counter()
    await counter.increment()
    print(await counter.current())
    ```

    `@MainActor` is a global actor that serialises work on the main thread — \
    ideal for UI updates.

    ---

    ## Comparison of Concurrency Approaches

    | Approach            | Cancellation | Structured | Readable |
    |---------------------|:------------:|:----------:|:--------:|
    | Completion handlers | Manual       | No         | Low      |
    | Combine             | AnyCancellable | Partial   | Medium   |
    | async/await         | Automatic    | Yes        | High     |
    | TaskGroup           | Automatic    | Yes        | High     |

    ## Migration Checklist

    When migrating existing code to structured concurrency, work through the \
    following steps:

    - Audit every `DispatchQueue.async` call and determine whether it can become `await`
    - Replace `DispatchGroup` fan-out patterns with `withTaskGroup`
    - Mark view models and data-layer types with `@MainActor` where appropriate
    - Annotate any shared mutable state with `actor` or protect it behind a serial queue
    - Enable the `StrictConcurrency` Swift setting (`-strict-concurrency=complete`) \
    in your build settings to surface remaining races at compile time

    ## Ordered Migration Steps

    1. Enable `StrictConcurrency=targeted` first to see warnings without errors
    2. Fix all `@Sendable` closure warnings
    3. Upgrade to `StrictConcurrency=complete` and address remaining actor-isolation errors
    4. Remove legacy `DispatchQueue` and `OperationQueue` callsites
    5. Delete dead completion-handler code paths

    ## Inline Code Examples

    Use `Task.sleep(nanoseconds:)` for delays, `Task.checkCancellation()` to honour \
    cancellation, and `TaskLocal` for structured propagation of values like request \
    identifiers or logging contexts through async call trees.

    ![Concurrency diagram](https://example.com/concurrency.png)

    > Note: All examples target Swift 5.9+ and macOS 14+.
    """

    // MARK: - Parse Performance

    /// Measures the wall-clock and CPU time spent in `parseMarkdownSegments(_:)`
    /// on a realistic ~500-word document.  Establishes a baseline on first run;
    /// later runs fail if wall time regresses beyond the XCTest default threshold.
    func testMarkdownParsePerformance() {
        measure(metrics: [XCTClockMetric(), XCTCPUMetric()]) {
            _ = parseMarkdownSegments(Self.sampleMarkdown)
        }
    }

    // MARK: - Segment Grouping Performance

    /// Measures only the `computeGroupedSegments()` step (accessed indirectly
    /// through the view's internal `groupedSegments` property by exercising the
    /// same pure logic).  Parsing is done once outside the measured block so
    /// that the baseline captures only the grouping pass.
    func testGroupedSegmentsPerformance() {
        let segments = parseMarkdownSegments(Self.sampleMarkdown)
        measure(metrics: [XCTClockMetric(), XCTCPUMetric()]) {
            for _ in 0..<200 {
                _ = groupSegments(segments)
            }
        }
    }

    // MARK: - Round-Trip Performance

    /// Measures a full round-trip: parse raw markdown, group segments, then
    /// build the combined `AttributedString` for the first selectable run.
    /// This mirrors the work performed on every SwiftUI body evaluation for a
    /// chat message.
    func testFullRenderPipelinePerformance() {
        measure(metrics: [XCTClockMetric(), XCTCPUMetric()]) {
            let segments = parseMarkdownSegments(Self.sampleMarkdown)
            let groups = groupSegments(segments)
            // Build the attributed string for each selectable run (the most
            // expensive step).  Use the internal free function exposed via
            // @testable import.
            for group in groups {
                if case .selectableRun(let run) = group {
                    _ = makeAttributedString(from: run)
                }
            }
        }
    }

    // MARK: - Large-Input Parse Performance

    /// Measures parsing with a 10x-repeated document (~5 000 words) to surface
    /// super-linear complexity regressions that may not be visible at 500 words.
    func testMarkdownParsePerformanceLargeInput() {
        let largeSample = (0..<10).map { _ in Self.sampleMarkdown }.joined(separator: "\n\n")
        measure(metrics: [XCTClockMetric(), XCTCPUMetric()]) {
            _ = parseMarkdownSegments(largeSample)
        }
    }
}

// MARK: - Test Helpers

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
/// text segment's inline markdown.  Mirrors the hot path in
/// `MarkdownSegmentView.buildAttributedStringUncached(from:…)`, including the
/// inline code styling pass that applies foreground/background colors and
/// thin-space padding to inline code spans.
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
    // mirrors the pass in buildAttributedStringUncached (lines ~350-365).
    var codeRanges: [Range<AttributedString.Index>] = []
    for run in result.runs {
        if let intent = run.inlinePresentationIntent, intent.contains(.code) {
            codeRanges.append(run.range)
        }
    }
    for range in codeRanges.reversed() {
        result[range].foregroundColor = VColor.codeText
        result[range].backgroundColor = VColor.codeBackground
        var trailing = AttributedString("\u{2009}")
        trailing.backgroundColor = VColor.codeBackground
        result.insert(trailing, at: range.upperBound)
        var leading = AttributedString("\u{2009}")
        leading.backgroundColor = VColor.codeBackground
        result.insert(leading, at: range.lowerBound)
    }

    return result
}
