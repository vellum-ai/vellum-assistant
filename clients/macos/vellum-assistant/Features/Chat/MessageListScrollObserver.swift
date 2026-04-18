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

    func makeCoordinator() -> Coordinator {
        Coordinator(
            onGeometryChange: onGeometryChange,
            shouldPreserveScrollAnchor: shouldPreserveScrollAnchor
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
            shouldPreserveScrollAnchor: @escaping @MainActor () -> Bool
        ) {
            self.onGeometryChange = onGeometryChange
            self.shouldPreserveScrollAnchor = shouldPreserveScrollAnchor
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

            // Anchor preservation: when the streaming assistant response
            // grows and the user is reading older content above the visual
            // bottom, leaving the offset alone lets the new content push
            // the visible region upward off the top of the viewport (the
            // streaming message lives at doc Y=0; growing it shifts every
            // higher-Y item further from the visual bottom). Shift the
            // clip view by the height delta so the visible content stays
            // put. The decision lives in `ScrollAnchorPreserver` so the
            // logic is unit-testable without an NSScrollView.
            if let delta = ScrollAnchorPreserver.offsetDelta(
                currentContentHeight: currentContentHeight,
                lastContentHeight: lastContentHeight,
                contentOffsetY: clipView.bounds.origin.y,
                shouldPreserveAnchor: shouldPreserveScrollAnchor(),
                isUserLiveScrolling: isLiveScrolling,
                pinnedToLatestEpsilon: Self.pinnedToLatestEpsilon
            ) {
                let newOrigin = NSPoint(
                    x: clipView.bounds.origin.x,
                    y: clipView.bounds.origin.y + delta
                )
                clipView.setBoundsOrigin(newOrigin)
                scrollView.reflectScrolledClipView(clipView)
            }
            lastContentHeight = currentContentHeight

            let snapshot = ScrollGeometrySnapshot(
                contentOffsetY: clipView.bounds.origin.y,
                contentHeight: currentContentHeight,
                containerHeight: clipView.bounds.height,
                visibleRectHeight: scrollView.documentVisibleRect.height
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
                    self?.isLiveScrolling = true
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
    /// Returns the offset delta to add to `contentOffsetY` so the visible
    /// content stays anchored when the document grows, or `nil` if no
    /// adjustment is needed.
    ///
    /// In the inverted scroll, `contentOffsetY = 0` is the visual bottom
    /// (latest messages). The streaming assistant response lives at the
    /// low end of the document (doc Y near 0), so its growth pushes every
    /// higher-Y item further from the visual bottom. A user reading older
    /// content (positive `contentOffsetY`) sees that content scroll upward
    /// off the top of the viewport unless the offset is shifted by the
    /// growth amount.
    static func offsetDelta(
        currentContentHeight: CGFloat,
        lastContentHeight: CGFloat,
        contentOffsetY: CGFloat,
        shouldPreserveAnchor: Bool,
        isUserLiveScrolling: Bool,
        pinnedToLatestEpsilon: CGFloat
    ) -> CGFloat? {
        guard shouldPreserveAnchor,
              !isUserLiveScrolling,
              lastContentHeight > 0,
              currentContentHeight > lastContentHeight,
              contentOffsetY > pinnedToLatestEpsilon
        else { return nil }
        return currentContentHeight - lastContentHeight
    }
}
