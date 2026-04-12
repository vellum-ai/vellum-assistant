import AppKit
import SwiftUI
import XCTest
@testable import VellumAssistantLib

@MainActor
final class ThinkingBlockViewTests: XCTestCase {
    /// Regression test for a crash where `parseMarkdownSegments` applied to
    /// thinking-block content with italics separated by blank lines tripped
    /// an NSRange assertion during expanded-card seeding.
    /// (See commit `adaf6e796`.)
    func testParseMarkdownSegmentsDoesNotCrashOnItalicsAcrossBlankLines() {
        _ = parseMarkdownSegments("""
        *gasps against the fabric*

        *muffled, breathless*
        """)
    }

    /// Host a SwiftUI view in an off-screen window so `onAppear` and friends
    /// actually fire. Evaluating `view.body` alone constructs the value but
    /// does not drive the SwiftUI lifecycle.
    private func hostAndDriveLifecycle<V: View>(_ view: V) {
        let hosting = NSHostingController(rootView: view)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentViewController = hosting
        window.orderFrontRegardless()
        hosting.view.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        window.orderOut(nil)
        window.contentViewController = nil
    }

    /// Smoke test that `ThinkingBlockView` renders end-to-end against the
    /// store-backed expansion without crashing, with the store injected via
    /// the environment so the view reads the toggled state.
    func testThinkingBlockBodyEvaluatesWithStoreInjection() {
        let store = ThinkingBlockExpansionStore()
        store.toggle("test-key")

        let view = ThinkingBlockView(
            content: "thinking content",
            isStreaming: false,
            expansionKey: "test-key"
        )
        .environment(\.thinkingBlockExpansionStore, store)

        hostAndDriveLifecycle(view)
    }

    /// Regression test for expanded thinking blocks going blank at the end of
    /// an active turn. When `MessageListContentView` tears down and rebuilds
    /// the wrapped subtree as `isActiveTurn` flips true → false, a freshly
    /// constructed `ThinkingBlockView` reads `isExpanded == true` from the
    /// store (preserved by commit `54e20c80b`) but its `@State` segment cache
    /// is empty. Neither `onChange(of: content)` nor `onChange(of: isExpanded)`
    /// fires on initial values, so the block rendered blank until the user
    /// manually toggled it. `.onAppear` now seeds the cache in that case.
    ///
    /// Must host the view in an `NSHostingController` attached to a window
    /// so SwiftUI actually runs `.onAppear` — evaluating `view.body` alone
    /// does not drive the lifecycle. The expansion store is injected via
    /// `.environment` so the view reads the toggled (expanded) state rather
    /// than the environment default.
    func testThinkingBlockExpandedOnAppearSeedsSegmentCache() {
        let store = ThinkingBlockExpansionStore()
        store.toggle("turn-end-key")

        let view = ThinkingBlockView(
            content: """
            # Reasoning

            Step one: consider the input.

            *pauses*

            Step two: produce the output.
            """,
            isStreaming: false,
            expansionKey: "turn-end-key"
        )
        .environment(\.thinkingBlockExpansionStore, store)

        hostAndDriveLifecycle(view)
    }
}
