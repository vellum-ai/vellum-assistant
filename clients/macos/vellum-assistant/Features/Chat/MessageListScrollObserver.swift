import AppKit
import SwiftUI

/// Observes the underlying `NSScrollView` and reports geometry snapshots
/// without relying on SwiftUI's `onScrollGeometryChange` modifier.
struct MessageListScrollObserver: NSViewRepresentable {
    let onGeometryChange: @MainActor (ScrollGeometrySnapshot) -> Void
    /// Whether to absorb content-height growth by shifting the clip view
    /// so the visible content stays anchored as the streaming response
    /// grows. Re-evaluated on every potential compensation point — return
    /// `false` during pagination (where the explicit scroll-to-anchor is
    /// the source of truth). Compensation is additionally gated on the
    /// user being above the visual bottom (when pinned to latest, growth
    /// auto-follows naturally in the inverted scroll) and on the user
    /// not being in an active live-scroll gesture (tracked internally
    /// via `NSScrollView.willStart/didEndLiveScrollNotification`, so
    /// mid-gesture height growth — most often `LazyVStack` lazy cell
    /// materialization — never fights the user's scroll).
    let shouldPreserveScrollAnchor: @MainActor () -> Bool
    /// Fired whenever `ScrollAnchorPreserver.offsetDelta(...)` returns a
    /// non-nil value (the clip view was shifted to absorb content-height
    /// growth). Used only by the scroll-debug overlay to count anchor
    /// activations. `nil` when no observer cares.
    var onAnchorShift: (@MainActor () -> Void)? = nil
    /// Fired for every anchor-preserver decision where the content height
    /// actually changed, regardless of whether the shift was applied or
    /// skipped. Used by the scroll-debug recorder to attribute missed
    /// compensations (content shrinks, live-scroll gates, first-layout).
    /// `nil` when no observer cares.
    var onAnchorDecision: (@MainActor (ScrollAnchorDecisionEvent) -> Void)? = nil

    func makeCoordinator() -> Coordinator {
        Coordinator(
            onGeometryChange: onGeometryChange,
            shouldPreserveScrollAnchor: shouldPreserveScrollAnchor,
            onAnchorShift: onAnchorShift,
            onAnchorDecision: onAnchorDecision
        )
    }

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        context.coordinator.hostView = view
        DispatchQueue.main.async { [weak view] in
            guard let view else { return }
            context.coordinator.attachIfNeeded(to: view)
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.onGeometryChange = onGeometryChange
        context.coordinator.shouldPreserveScrollAnchor = shouldPreserveScrollAnchor
        context.coordinator.onAnchorShift = onAnchorShift
        context.coordinator.onAnchorDecision = onAnchorDecision
        DispatchQueue.main.async { [weak nsView] in
            guard let nsView else { return }
            context.coordinator.attachIfNeeded(to: nsView)
            context.coordinator.emitCurrentSnapshotIfPossible()
        }
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        coordinator.detach()
    }

    @MainActor
    final class Coordinator {
        weak var hostView: NSView?
        weak var scrollView: NSScrollView?
        weak var clipView: NSClipView?
        weak var documentView: NSView?
        var onGeometryChange: @MainActor (ScrollGeometrySnapshot) -> Void
        var shouldPreserveScrollAnchor: @MainActor () -> Bool
        var onAnchorShift: (@MainActor () -> Void)?
        var onAnchorDecision: (@MainActor (ScrollAnchorDecisionEvent) -> Void)?
        private var observers: [NSObjectProtocol] = []
        private var lastSnapshot: ScrollGeometrySnapshot?
        /// Last observed `documentView.frame.height`. Used to compute the
        /// growth delta for anchor preservation. Reset to 0 on attach/detach
        /// so a stale baseline from a previous conversation cannot apply
        /// a phantom delta on the first emit of a new ScrollView.
        private var lastContentHeight: CGFloat = 0
        /// Tracks whether an AppKit live scroll (trackpad/wheel gesture plus
        /// momentum decay) is currently in progress. Bracketed by
        /// `willStartLiveScrollNotification` / `didEndLiveScrollNotification`
        /// on the `NSScrollView`. Anchor preservation is suppressed while
        /// this is true so content-height growth from `LazyVStack` lazy cell
        /// materialization — or any other concurrent source — cannot fight
        /// the user's gesture with a mid-gesture `setBoundsOrigin` shift.
        private var isLiveScrolling: Bool = false
        /// In inverted-scroll coords, `contentOffsetY ≈ 0` means the user is
        /// pinned to the visual bottom (latest messages). Below this small
        /// epsilon we treat the user as pinned and let streaming growth
        /// auto-follow naturally instead of compensating.
        static let pinnedToLatestEpsilon: CGFloat = 8

        init(
            onGeometryChange: @escaping @MainActor (ScrollGeometrySnapshot) -> Void,
            shouldPreserveScrollAnchor: @escaping @MainActor () -> Bool,
            onAnchorShift: (@MainActor () -> Void)? = nil,
            onAnchorDecision: (@MainActor (ScrollAnchorDecisionEvent) -> Void)? = nil
        ) {
            self.onGeometryChange = onGeometryChange
            self.shouldPreserveScrollAnchor = shouldPreserveScrollAnchor
            self.onAnchorShift = onAnchorShift
            self.onAnchorDecision = onAnchorDecision
        }

        func attachIfNeeded(to hostView: NSView) {
            self.hostView = hostView
            guard let scrollView = hostView.enclosingScrollView else { return }
            let clipView = scrollView.contentView
            let documentView = scrollView.documentView

            guard self.scrollView !== scrollView
                || self.clipView !== clipView
                || self.documentView !== documentView
            else { return }

            removeObservers()
            self.scrollView = scrollView
            self.clipView = clipView
            self.documentView = documentView
            // Reset the baseline so the first emit after a re-attach (e.g.
            // conversation switch destroys + recreates the ScrollView) does
            // not treat the new content height as a delta over the old.
            self.lastContentHeight = 0
            installObservers()
        }

        func detach() {
            removeObservers()
            hostView = nil
            scrollView = nil
            clipView = nil
            documentView = nil
            lastSnapshot = nil
            lastContentHeight = 0
            isLiveScrolling = false
        }

        func emitCurrentSnapshotIfPossible() {
            guard let scrollView,
                  let documentView = scrollView.documentView
            else { return }

            let clipView = scrollView.contentView
            let currentContentHeight = documentView.frame.height
            let preOffsetY = clipView.bounds.origin.y
            let contentHDelta = currentContentHeight - lastContentHeight

            // Anchor preservation: when the streaming assistant response
            // grows and the user is reading older content above the visual
            // bottom, leaving the offset alone lets the new content push
            // the visible region upward off the top of the viewport (the
            // streaming message lives at doc Y=0; growing it shifts every
            // higher-Y item further from the visual bottom). Shift the
            // clip view by the height delta so the visible content stays
            // put. The decision lives in `ScrollAnchorPreserver` so the
            // logic is unit-testable without an NSScrollView.
            let decision = ScrollAnchorPreserver.decide(
                currentContentHeight: currentContentHeight,
                lastContentHeight: lastContentHeight,
                contentOffsetY: preOffsetY,
                shouldPreserveAnchor: shouldPreserveScrollAnchor(),
                isUserLiveScrolling: isLiveScrolling,
                pinnedToLatestEpsilon: Self.pinnedToLatestEpsilon
            )
            if case .applied(let delta) = decision {
                let newOrigin = NSPoint(
                    x: clipView.bounds.origin.x,
                    y: preOffsetY + delta
                )
                clipView.setBoundsOrigin(newOrigin)
                scrollView.reflectScrolledClipView(clipView)
                onAnchorShift?()
            }
            // Telemetry: only fire when content height actually changed so
            // the recorder isn't spammed with no-op decisions from bounds
            // notifications that didn't involve a layout change.
            if contentHDelta != 0, let onAnchorDecision {
                onAnchorDecision(ScrollAnchorDecisionEvent(
                    outcome: decision,
                    contentHDelta: contentHDelta,
                    preOffsetY: preOffsetY,
                    postOffsetY: clipView.bounds.origin.y,
                    at: Date()
                ))
            }
            lastContentHeight = currentContentHeight

            let snapshot = ScrollGeometrySnapshot(
                contentOffsetY: clipView.bounds.origin.y,
                contentHeight: currentContentHeight,
                containerHeight: clipView.bounds.height,
                visibleRectHeight: scrollView.documentVisibleRect.height,
                isLiveScrolling: isLiveScrolling
            )
            guard snapshot != lastSnapshot else { return }
            lastSnapshot = snapshot
            onGeometryChange(snapshot)
        }

        private func installObservers() {
            guard let scrollView else { return }
            let clipView = scrollView.contentView
            clipView.postsBoundsChangedNotifications = true
            clipView.postsFrameChangedNotifications = true
            scrollView.postsFrameChangedNotifications = true
            documentView?.postsFrameChangedNotifications = true

            let center = NotificationCenter.default
            observers.append(center.addObserver(
                forName: NSView.boundsDidChangeNotification,
                object: clipView,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.emitCurrentSnapshotIfPossible()
                }
            })
            observers.append(center.addObserver(
                forName: NSView.frameDidChangeNotification,
                object: clipView,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.emitCurrentSnapshotIfPossible()
                }
            })
            observers.append(center.addObserver(
                forName: NSView.frameDidChangeNotification,
                object: scrollView,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.emitCurrentSnapshotIfPossible()
                }
            })
            if let documentView {
                observers.append(center.addObserver(
                    forName: NSView.frameDidChangeNotification,
                    object: documentView,
                    queue: .main
                ) { [weak self] _ in
                    Task { @MainActor [weak self] in
                        self?.emitCurrentSnapshotIfPossible()
                    }
                })
            }

            // Bracket the user's gesture (and its momentum decay) so anchor
            // preservation doesn't call `setBoundsOrigin` while the user is
            // actively scrolling. Without this, any content-height growth
            // between scroll ticks — most often `LazyVStack` lazy cell
            // materialization as new cells come into view — produces an
            // upward `clipView` shift that cancels the user's input and
            // traps them in the current region.
            observers.append(center.addObserver(
                forName: NSScrollView.willStartLiveScrollNotification,
                object: scrollView,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.isLiveScrolling = true
                    // Emit so downstream observers (e.g. the debug overlay)
                    // see `isLiveScrolling` flip immediately on gesture start
                    // rather than waiting for the first scroll tick to carry
                    // the new flag through.
                    self.emitCurrentSnapshotIfPossible()
                }
            })
            observers.append(center.addObserver(
                forName: NSScrollView.didEndLiveScrollNotification,
                object: scrollView,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.isLiveScrolling = false
                    // Re-baseline without applying a delta: any growth
                    // that accumulated during the gesture has already
                    // been absorbed into the user's new scroll position,
                    // so we must not retroactively compensate for it on
                    // the next passive emit.
                    self.lastContentHeight = self.documentView?.frame.height ?? 0
                    self.emitCurrentSnapshotIfPossible()
                }
            })

            emitCurrentSnapshotIfPossible()
        }

        private func removeObservers() {
            let center = NotificationCenter.default
            for observer in observers {
                center.removeObserver(observer)
            }
            observers.removeAll()
        }
    }
}

/// Pure decision logic for inverted-scroll anchor preservation. Extracted
/// from `MessageListScrollObserver.Coordinator` so the streaming-vs-pinned
/// decision tree can be exercised in unit tests without standing up a real
/// `NSScrollView`.
enum ScrollAnchorPreserver {
    /// Reason the preserver chose not to shift the offset. Used by the
    /// scroll-debug telemetry so each skipped decision is attributable.
    enum SkipReason: String {
        case anchorPreservationDisabled
        case userLiveScrolling
        case firstLayout
        case notGrowth
        case pinnedToLatest
    }

    /// Outcome of a single `decide(...)` call.
    enum Decision {
        case applied(delta: CGFloat)
        case skipped(SkipReason)
    }

    /// Rich decision for a single layout-change notification. `offsetDelta`
    /// is a thin convenience over this, kept for tests and simple callers
    /// that only need the CGFloat?.
    ///
    /// In the inverted scroll, `contentOffsetY = 0` is the visual bottom
    /// (latest messages). The streaming assistant response lives at the
    /// low end of the document (doc Y near 0), so its growth pushes every
    /// higher-Y item further from the visual bottom. A user reading older
    /// content (positive `contentOffsetY`) sees that content scroll upward
    /// off the top of the viewport unless the offset is shifted by the
    /// growth amount.
    static func decide(
        currentContentHeight: CGFloat,
        lastContentHeight: CGFloat,
        contentOffsetY: CGFloat,
        shouldPreserveAnchor: Bool,
        isUserLiveScrolling: Bool,
        pinnedToLatestEpsilon: CGFloat
    ) -> Decision {
        if !shouldPreserveAnchor { return .skipped(.anchorPreservationDisabled) }
        if isUserLiveScrolling { return .skipped(.userLiveScrolling) }
        if lastContentHeight <= 0 { return .skipped(.firstLayout) }
        if currentContentHeight <= lastContentHeight { return .skipped(.notGrowth) }
        if contentOffsetY <= pinnedToLatestEpsilon { return .skipped(.pinnedToLatest) }
        return .applied(delta: currentContentHeight - lastContentHeight)
    }

    /// Returns the offset delta to add to `contentOffsetY` so the visible
    /// content stays anchored when the document grows, or `nil` if no
    /// adjustment is needed. Kept for tests and simple callers — see
    /// `decide(...)` for the richer outcome.
    static func offsetDelta(
        currentContentHeight: CGFloat,
        lastContentHeight: CGFloat,
        contentOffsetY: CGFloat,
        shouldPreserveAnchor: Bool,
        isUserLiveScrolling: Bool,
        pinnedToLatestEpsilon: CGFloat
    ) -> CGFloat? {
        switch decide(
            currentContentHeight: currentContentHeight,
            lastContentHeight: lastContentHeight,
            contentOffsetY: contentOffsetY,
            shouldPreserveAnchor: shouldPreserveAnchor,
            isUserLiveScrolling: isUserLiveScrolling,
            pinnedToLatestEpsilon: pinnedToLatestEpsilon
        ) {
        case .applied(let delta): return delta
        case .skipped: return nil
        }
    }
}

/// Single anchor-preserver decision captured for the debug HUD / recorder.
/// Fired on every call where `contentHDelta` is non-zero, including skips
/// so we can attribute missed compensations (shrinks, live-scroll blocks,
/// first-layout).
struct ScrollAnchorDecisionEvent {
    let outcome: ScrollAnchorPreserver.Decision
    let contentHDelta: CGFloat
    let preOffsetY: CGFloat
    let postOffsetY: CGFloat
    let at: Date
}
