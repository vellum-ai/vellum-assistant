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
    /// Fired when `contentH` changes by a small amount (< 8pt) — used by the
    /// scroll-debug overlay to localise which descendant of the document view
    /// actually grew or shrank. Reports only views whose frame height changed
    /// vs. the previous emit, so the log line lists candidate sources of the
    /// phantom 1pt-per-frame drift that the anchor preserver is compensating
    /// for. `nil` (and the diagnostic walk is skipped entirely) when no
    /// observer cares, so the cost is paid only with the debug overlay on.
    var onContentHeightSourceDiagnostic: (@MainActor (ContentHeightSourceDiagnosticEvent) -> Void)? = nil

    func makeCoordinator() -> Coordinator {
        Coordinator(
            onGeometryChange: onGeometryChange,
            shouldPreserveScrollAnchor: shouldPreserveScrollAnchor,
            onAnchorShift: onAnchorShift,
            onAnchorDecision: onAnchorDecision,
            onContentHeightSourceDiagnostic: onContentHeightSourceDiagnostic
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
        context.coordinator.onContentHeightSourceDiagnostic = onContentHeightSourceDiagnostic
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
        var onContentHeightSourceDiagnostic: (@MainActor (ContentHeightSourceDiagnosticEvent) -> Void)?
        private var observers: [NSObjectProtocol] = []
        private var lastSnapshot: ScrollGeometrySnapshot?
        /// Per-subtree height snapshot, keyed by the descendant's index path
        /// from the document view (e.g. `"0/3/1"`). Populated only when an
        /// `onContentHeightSourceDiagnostic` observer is wired up; cleared on
        /// detach so a scroll-view swap can't carry stale heights across
        /// conversations. Walking depth-first by index path gives a stable
        /// identity across SwiftUI's view re-evaluations, where the underlying
        /// `NSView` object identifiers shift even when the layout doesn't.
        private var lastSubviewHeights: [String: CGFloat] = [:]
        /// Cap on diagnostic walk depth — SwiftUI hosting hierarchies are deep
        /// and the walk runs on every small contentH delta, so we trim the
        /// tail to keep the per-emit cost bounded. 12 is enough to reach the
        /// LazyVStack row level in practice.
        private static let diagnosticWalkMaxDepth: Int = 12
        /// Upper bound on the magnitude of a `contentHDelta` worth walking for.
        /// Large deltas come from layout-level events (pagination snap, height
        /// estimate corrections after a column-width change, conversation
        /// switches) — those don't need per-frame attribution. The
        /// instrumentation targets the steady ~1pt drift seen during
        /// streaming.
        private static let diagnosticContentHDeltaThreshold: CGFloat = 8
        /// Last observed `documentView.frame.height`. Kept for telemetry
        /// (`ScrollAnchorDecisionEvent.contentHDelta`) only — the anchor
        /// preserver no longer compensates against this value, because
        /// `contentH` changes can come from sources that don't shift the
        /// visible rows (LazyVStack height estimates, off-viewport growth
        /// that doesn't propagate up the materialized subtree). Use
        /// `lastReferenceY` for the actual compensation baseline.
        private var lastContentHeight: CGFloat = 0
        /// Index-path to a stable visible descendant of `documentView` whose
        /// `minY` movement we compensate against (e.g. `"0/2"` is the third
        /// subview of `documentView`'s first child). Picked when the
        /// previous path no longer resolves to a usable view in the current
        /// tree (e.g. LazyVStack reflowed and the slot is gone or out of
        /// the viewport).
        ///
        /// Compensating against this descendant's `minY` in `documentView`
        /// coords — instead of the global `contentHDelta` — eliminates the
        /// "streaming response below the viewport grows by 1 pt/token, but
        /// no visible row shifts" failure mode the recorded CSVs show.
        ///
        /// We track by index path rather than a weak `NSView` reference
        /// because LazyVStack reflows destroy and recreate the underlying
        /// `NSView` at the same logical position. A weak reference becomes
        /// `nil` across that destruction, forcing us to re-pick on every
        /// reflow and miss the chunky `+25–100 pt` `minY` shift that
        /// reflow actually represents (recorded CSV shows only 1 of 4
        /// chunky shifts firing the anchor under the weak-reference
        /// scheme, leaving the other three to SwiftUI's late offset
        /// adjustment and producing a "jump back and forth" flicker).
        /// Paths survive the destruction; the resolved view at that path
        /// post-reflow is what we diff against.
        private var anchorReferencePath: String?
        /// Cached `convert(.zero, to: documentView).y` of the view at
        /// `anchorReferencePath` from the last emit. The next emit's
        /// `Δref` is `currentY - lastReferenceY`, which is what we pass
        /// to `ScrollAnchorPreserver.decide`.
        private var lastReferenceY: CGFloat = 0
        /// Tracks whether an AppKit live scroll (trackpad/wheel gesture plus
        /// momentum decay) is currently in progress. Bracketed by
        /// `willStartLiveScrollNotification` / `didEndLiveScrollNotification`
        /// on the `NSScrollView`. Anchor preservation is suppressed while
        /// this is true so content-height growth from `LazyVStack` lazy cell
        /// materialization — or any other concurrent source — cannot fight
        /// the user's gesture with a mid-gesture `setBoundsOrigin` shift.
        private var isLiveScrolling: Bool = false
        /// Guards against synchronous re-entry of
        /// `emitCurrentSnapshotIfPossible`. `clipView.setBoundsOrigin(_:)`
        /// synchronously posts `NSView.boundsDidChangeNotification`, which our
        /// `queue: .main` observer dispatches synchronously via
        /// `MainActor.assumeIsolated`. Without this guard, the
        /// anchor-preservation branch would re-enter and call
        /// `setBoundsOrigin` again before `lastContentHeight` is updated,
        /// producing unbounded recursion until the main-thread stack overflows.
        private var isEmitting: Bool = false
        /// In inverted-scroll coords, `contentOffsetY ≈ 0` means the user is
        /// pinned to the visual bottom (latest messages). Below this small
        /// epsilon we treat the user as pinned and let streaming growth
        /// auto-follow naturally instead of compensating.
        static let pinnedToLatestEpsilon: CGFloat = 8

        init(
            onGeometryChange: @escaping @MainActor (ScrollGeometrySnapshot) -> Void,
            shouldPreserveScrollAnchor: @escaping @MainActor () -> Bool,
            onAnchorShift: (@MainActor () -> Void)? = nil,
            onAnchorDecision: (@MainActor (ScrollAnchorDecisionEvent) -> Void)? = nil,
            onContentHeightSourceDiagnostic: (@MainActor (ContentHeightSourceDiagnosticEvent) -> Void)? = nil
        ) {
            self.onGeometryChange = onGeometryChange
            self.shouldPreserveScrollAnchor = shouldPreserveScrollAnchor
            self.onAnchorShift = onAnchorShift
            self.onAnchorDecision = onAnchorDecision
            self.onContentHeightSourceDiagnostic = onContentHeightSourceDiagnostic
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
            // Reset live-scroll tracking: if the old scroll view emitted
            // `willStartLiveScrollNotification` but was replaced before
            // `didEndLiveScrollNotification` fired, the flag would stay
            // stuck `true` on the coordinator and suppress anchor
            // compensation in the new view until the user performed a
            // fresh full scroll cycle.
            self.isLiveScrolling = false
            self.lastSnapshot = nil
            // Same baseline reset for the diagnostic walk's snapshot — a
            // conversation switch destroys the old view tree, so stale paths
            // would no longer correspond to anything.
            self.lastSubviewHeights = [:]
            // Re-attach destroys the old view tree, so any prior reference
            // is now dangling. Reset explicitly so the first emit picks a
            // fresh reference from the new tree without computing a delta
            // against a stale Y.
            self.anchorReferencePath = nil
            self.lastReferenceY = 0
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
            lastSubviewHeights = [:]
            anchorReferencePath = nil
            lastReferenceY = 0
        }

        func emitCurrentSnapshotIfPossible() {
            guard !isEmitting else { return }
            isEmitting = true
            defer { isEmitting = false }

            guard let scrollView,
                  let documentView = scrollView.documentView
            else { return }

            let clipView = scrollView.contentView
            let currentContentHeight = documentView.frame.height
            let preOffsetY = clipView.bounds.origin.y
            let containerHeight = clipView.bounds.height
            let contentHDelta = currentContentHeight - lastContentHeight

            // Anchor preservation: when content above the visible region
            // shifts (because a message expanded, a thinking block opened,
            // an old image loaded), compensate `clipView.bounds.origin.y`
            // by the same amount so the visible rows hold their visual
            // position. The compensation amount is the movement of a
            // *concrete visible reference NSView* — not the global
            // `contentH` delta. Captured recordings show the streaming
            // response below the viewport grows by 1 pt/token while no
            // visible row's `minY` changes, so compensating by
            // `contentHDelta` would walk the user away from latest with
            // no corresponding visual cause. Tracking a reference view
            // instead skips that case cleanly.
            let referenceDelta = updateAndReadReferenceDelta(
                documentView: documentView,
                viewportY: preOffsetY,
                viewportHeight: containerHeight
            )
            let decision = ScrollAnchorPreserver.decide(
                compensationDelta: referenceDelta,
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
            // Diagnostic walk: when contentH changes and an observer is wired
            // up, walk the documentView's descendant tree to identify which
            // view(s) actually grew or shrank. Gated on the callback being
            // non-nil so the deep walk's cost is only paid with the
            // scroll-debug overlay on. Large deltas (pagination snap,
            // conversation switch) refresh the snapshot but skip the report —
            // those events don't need per-frame attribution.
            if contentHDelta != 0, let onContentHeightSourceDiagnostic {
                let changed = diffSubviewHeights(root: documentView)
                if abs(contentHDelta) < Self.diagnosticContentHDeltaThreshold {
                    onContentHeightSourceDiagnostic(ContentHeightSourceDiagnosticEvent(
                        contentHDelta: contentHDelta,
                        changedSubviews: changed,
                        at: Date()
                    ))
                }
            }
            // Advance the baseline on every emit, including jitter-skipped
            // frames. Leaving the baseline stale on a sub-threshold skip lets
            // subsequent bounds/scroll notifications (which don't change the
            // document height) still compute a non-zero `contentHDelta` against
            // the old baseline, producing inflated `onAnchorDecision` events
            // and false "missed compensation" entries in the debug overlay's
            // CSV. The SKIP decision itself is unchanged — only the bookkeeping.
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

            // `queue: .main` runs the block synchronously on the main thread
            // for the notification that's currently being delivered. We
            // `MainActor.assumeIsolated` to call the main-actor-isolated
            // Coordinator methods without deferring to a `Task`. Deferring
            // opens a 1-frame race where the display can draw the new
            // layout (post-growth/shrink contentH) before the anchor shift
            // has been applied to `clipView.bounds.origin.y`, which the user
            // perceives as a flicker at the streaming cadence.
            let center = NotificationCenter.default
            observers.append(center.addObserver(
                forName: NSView.boundsDidChangeNotification,
                object: clipView,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.emitCurrentSnapshotIfPossible()
                }
            })
            observers.append(center.addObserver(
                forName: NSView.frameDidChangeNotification,
                object: clipView,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.emitCurrentSnapshotIfPossible()
                }
            })
            observers.append(center.addObserver(
                forName: NSView.frameDidChangeNotification,
                object: scrollView,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.emitCurrentSnapshotIfPossible()
                }
            })
            if let documentView {
                observers.append(center.addObserver(
                    forName: NSView.frameDidChangeNotification,
                    object: documentView,
                    queue: .main
                ) { [weak self] _ in
                    MainActor.assumeIsolated {
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
                MainActor.assumeIsolated {
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
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.isLiveScrolling = false
                    // Re-baseline without applying a delta: any growth
                    // that accumulated during the gesture has already
                    // been absorbed into the user's new scroll position,
                    // so we must not retroactively compensate for it on
                    // the next passive emit. Both the content-height
                    // baseline (for telemetry) and the reference baseline
                    // (for the actual compensation) get reset. Drop the
                    // reference view entirely: the user likely scrolled
                    // it out of the viewport, so the next emit will pick
                    // a fresh one from the post-gesture viewport.
                    self.lastContentHeight = self.documentView?.frame.height ?? 0
                    self.anchorReferencePath = nil
                    self.lastReferenceY = 0
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

        /// Resolves the anchor reference for this emit and returns the
        /// signed delta (in points) that the reference's `minY` in
        /// `documentView` coords has moved since the previous emit. The
        /// Coordinator passes this delta to `ScrollAnchorPreserver.decide`
        /// as `compensationDelta`.
        ///
        /// Reference identity is stored as an *index path* from
        /// `documentView` (e.g. `"0/2"`). On each emit we re-resolve the
        /// path to whatever `NSView` is currently there. While the
        /// resolved view still has non-zero height we diff its `minY`
        /// against the cached value — even if it has been pushed outside
        /// the viewport by a large upstream reflow, since that final
        /// delta is exactly the shift we need to compensate for. When the
        /// reference no longer intersects the viewport we still report
        /// the delta, then pick a fresh in-viewport reference so the
        /// next emit can keep tracking. If the path no longer resolves
        /// (LazyVStack removed a slot, structure shifted) or the view
        /// collapsed to zero height, we have no reliable previous-Y to
        /// diff against, so we pick a new path and return `0`.
        ///
        /// Returning `0` is also what's expected on the first emit after
        /// attach: `anchorReferencePath` is `nil`, we pick one, and the
        /// decide function skips with `.noVisibleShift`.
        private func updateAndReadReferenceDelta(
            documentView: NSView,
            viewportY: CGFloat,
            viewportHeight: CGFloat
        ) -> CGFloat {
            let viewport = CGRect(
                x: 0,
                y: viewportY,
                width: documentView.bounds.width,
                height: viewportHeight
            )
            if let path = anchorReferencePath,
               let view = resolvePath(path, from: documentView),
               view.frame.height > 0 {
                let currentY = view.convert(.zero, to: documentView).y
                let delta = currentY - lastReferenceY
                let frameInDoc = view.convert(view.bounds, to: documentView)
                if frameInDoc.intersects(viewport) {
                    lastReferenceY = currentY
                    return delta
                }
                // Reference was pushed outside the viewport on this emit
                // (large upstream reflow — image load, thinking-block
                // expansion, history correction). Apply its final delta
                // as compensation, then pick a new in-viewport reference
                // so subsequent emits keep tracking visible content.
                pickAndStoreReference(in: documentView, viewport: viewport)
                return delta
            }
            // Path invalid — pick a new one. No delta on this emit since
            // there's no previous-Y to diff against.
            pickAndStoreReference(in: documentView, viewport: viewport)
            return 0
        }

        private func pickAndStoreReference(in documentView: NSView, viewport: CGRect) {
            let pick = pickAnchorReferencePath(in: documentView, viewport: viewport)
            anchorReferencePath = pick?.path
            lastReferenceY = pick?.view.convert(.zero, to: documentView).y ?? 0
        }

        /// Walks `path` (e.g. `"0/2"`) from `root`, returning the resolved
        /// descendant or `nil` if any index is out of bounds. Paths are
        /// expected to be small (depth ≤ `diagnosticWalkMaxDepth`), so the
        /// allocation overhead of splitting is negligible.
        private func resolvePath(_ path: String, from root: NSView) -> NSView? {
            var current: NSView = root
            for segment in path.split(separator: "/") {
                guard let index = Int(segment), index >= 0, index < current.subviews.count else {
                    return nil
                }
                current = current.subviews[index]
            }
            return current === root ? nil : current
        }

        /// Picks an anchor reference path from the materialized subtree of
        /// `documentView`. Walks depth-first and returns the deepest
        /// descendant whose frame intersects the viewport and has non-zero
        /// height. We prefer the deepest match so we land on a concrete
        /// row/leaf instead of the outer LazyVStack wrappers (which
        /// themselves grow as content streams).
        ///
        /// Intersection — rather than full containment — is required
        /// because real-world rows are often taller than the viewport in
        /// long-running conversations; a strict containment test would
        /// reject those and leave us with no reference. The deepest-match
        /// preference still bypasses the wrapper chain even when the
        /// outer rows are tall.
        private func pickAnchorReferencePath(in documentView: NSView, viewport: CGRect) -> (path: String, view: NSView)? {
            var bestPath: String?
            var bestView: NSView?
            var bestDepth = -1
            walkForReferencePath(
                in: documentView,
                path: "",
                depth: 0,
                documentView: documentView,
                viewport: viewport,
                bestPath: &bestPath,
                bestView: &bestView,
                bestDepth: &bestDepth
            )
            guard let path = bestPath, let view = bestView else { return nil }
            return (path, view)
        }

        private func walkForReferencePath(
            in parent: NSView,
            path: String,
            depth: Int,
            documentView: NSView,
            viewport: CGRect,
            bestPath: inout String?,
            bestView: inout NSView?,
            bestDepth: inout Int
        ) {
            guard depth < Self.diagnosticWalkMaxDepth else { return }
            for (index, child) in parent.subviews.enumerated() {
                guard child.frame.height > 0 else { continue }
                let frameInDoc = child.convert(child.bounds, to: documentView)
                guard frameInDoc.intersects(viewport) else { continue }
                let childPath = path.isEmpty ? "\(index)" : "\(path)/\(index)"
                if depth > bestDepth {
                    bestPath = childPath
                    bestView = child
                    bestDepth = depth
                }
                walkForReferencePath(
                    in: child,
                    path: childPath,
                    depth: depth + 1,
                    documentView: documentView,
                    viewport: viewport,
                    bestPath: &bestPath,
                    bestView: &bestView,
                    bestDepth: &bestDepth
                )
            }
        }

        /// Walks `root`'s descendant tree depth-first by index path, skipping
        /// `root` itself. For each descendant whose `frame.height` differs
        /// from the value captured on the previous walk, records a
        /// `ChangedSubview` describing where the change happened. Stores the
        /// new heights back into `lastSubviewHeights` so the next walk diffs
        /// against fresh state.
        ///
        /// `root` (the document view) is excluded from the report because its
        /// height delta is already conveyed by `contentHDelta` — including it
        /// would just duplicate that signal at every emit.
        ///
        /// The index path (`"0/3/1"`) is intentionally used as the identity
        /// key — `NSView` object identifiers drift across SwiftUI view
        /// re-evaluations even when the underlying layout is identical, but
        /// the position of a subview in its parent's `subviews` array is
        /// stable enough for short-window diagnostic comparison.
        private func diffSubviewHeights(root: NSView) -> [ContentHeightSourceDiagnosticEvent.ChangedSubview] {
            var current: [String: CGFloat] = [:]
            var changed: [ContentHeightSourceDiagnosticEvent.ChangedSubview] = []
            for (index, child) in root.subviews.enumerated() {
                captureHeights(view: child, path: "\(index)", depth: 1, into: &current, changed: &changed)
            }
            lastSubviewHeights = current
            return changed
        }

        private func captureHeights(
            view: NSView,
            path: String,
            depth: Int,
            into current: inout [String: CGFloat],
            changed: inout [ContentHeightSourceDiagnosticEvent.ChangedSubview]
        ) {
            let height = view.frame.height
            current[path] = height
            if let previous = lastSubviewHeights[path], previous != height {
                changed.append(ContentHeightSourceDiagnosticEvent.ChangedSubview(
                    path: path,
                    typeName: String(describing: type(of: view)),
                    previousHeight: previous,
                    currentHeight: height,
                    minY: view.frame.minY
                ))
            }
            guard depth < Self.diagnosticWalkMaxDepth else { return }
            for (index, child) in view.subviews.enumerated() {
                captureHeights(view: child, path: "\(path)/\(index)", depth: depth + 1, into: &current, changed: &changed)
            }
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
        case noVisibleShift
        case jitterBelowThreshold
        case pinnedToLatest
    }

    /// Subpixel layout oscillations (transient relayouts below the viewport,
    /// font-metric rounding, etc.) produce tiny non-zero deltas that are
    /// invisible to the user but still trigger `setBoundsOrigin`. Compensating
    /// on every such delta can accumulate upward drift even when net height is
    /// unchanged (e.g. `+0.2, -0.2, +0.2` sequences). Gate compensation on a
    /// minimum delta magnitude so jitter is treated as noise.
    static let minCompensationDelta: CGFloat = 1

    /// Outcome of a single `decide(...)` call.
    enum Decision {
        case applied(delta: CGFloat)
        case skipped(SkipReason)
    }

    /// Rich decision for a single layout-change notification. `offsetDelta`
    /// is a thin convenience over this, kept for tests and simple callers
    /// that only need the `CGFloat?`.
    ///
    /// `compensationDelta` is the signed movement of the *anchor reference
    /// view* in `documentView` coords since the previous emit. Compensating
    /// against the reference's movement — instead of the global
    /// `contentHDelta` — handles the case where `contentH` grows without
    /// visible rows shifting (streaming response below the viewport, lazy
    /// height-estimate corrections in off-viewport rows). Recorded CSVs
    /// caught the old `contentHDelta` formulation walking the user away
    /// from latest at ~120 pt/sec while no row's `minY` changed; the
    /// reference-based formulation skips those frames cleanly with
    /// `.noVisibleShift`.
    static func decide(
        compensationDelta: CGFloat,
        contentOffsetY: CGFloat,
        shouldPreserveAnchor: Bool,
        isUserLiveScrolling: Bool,
        pinnedToLatestEpsilon: CGFloat
    ) -> Decision {
        if !shouldPreserveAnchor { return .skipped(.anchorPreservationDisabled) }
        if isUserLiveScrolling { return .skipped(.userLiveScrolling) }
        if compensationDelta == 0 { return .skipped(.noVisibleShift) }
        if abs(compensationDelta) < Self.minCompensationDelta {
            return .skipped(.jitterBelowThreshold)
        }
        if contentOffsetY <= pinnedToLatestEpsilon { return .skipped(.pinnedToLatest) }
        return .applied(delta: compensationDelta)
    }

    /// Returns the offset delta to add to `contentOffsetY` so the visible
    /// content stays anchored when the reference view's position changes,
    /// or `nil` if no adjustment is needed. Kept for tests and simple
    /// callers — see `decide(...)` for the richer outcome.
    static func offsetDelta(
        compensationDelta: CGFloat,
        contentOffsetY: CGFloat,
        shouldPreserveAnchor: Bool,
        isUserLiveScrolling: Bool,
        pinnedToLatestEpsilon: CGFloat
    ) -> CGFloat? {
        switch decide(
            compensationDelta: compensationDelta,
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

/// Per-emit attribution payload describing which subviews of the document
/// view actually changed height when `contentH` ticked by a small amount.
/// Emitted only when the scroll-debug overlay is on (the view layer wires
/// up `onContentHeightSourceDiagnostic` only in that case). The view layer
/// is responsible for logging — keeping the observer free of `os.Logger`
/// dependencies preserves its unit-testability.
struct ContentHeightSourceDiagnosticEvent {
    let contentHDelta: CGFloat
    let changedSubviews: [ChangedSubview]
    let at: Date

    struct ChangedSubview {
        /// Index path from the document view (`"0/3/1"`) — stable across
        /// SwiftUI view re-evaluations within a single conversation.
        let path: String
        /// Swift type name (often a SwiftUI hosting wrapper like
        /// `_TtGC7SwiftUI...`, occasionally a plain `NSView` subclass).
        let typeName: String
        let previousHeight: CGFloat
        let currentHeight: CGFloat
        /// Frame `minY` in the parent's coordinate space — useful for
        /// locating the change in the inverted layout (small `minY` is near
        /// the visual bottom / streaming end).
        let minY: CGFloat
    }
}
