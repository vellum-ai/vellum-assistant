import AppKit
import SwiftUI

/// Observes the underlying `NSScrollView` and reports geometry snapshots
/// without relying on SwiftUI's `onScrollGeometryChange` modifier.
struct MessageListScrollObserver: NSViewRepresentable {
    let onGeometryChange: @MainActor (ScrollGeometrySnapshot) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onGeometryChange: onGeometryChange)
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
        private var observers: [NSObjectProtocol] = []
        private var lastSnapshot: ScrollGeometrySnapshot?

        init(onGeometryChange: @escaping @MainActor (ScrollGeometrySnapshot) -> Void) {
            self.onGeometryChange = onGeometryChange
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
            installObservers()
        }

        func detach() {
            removeObservers()
            hostView = nil
            scrollView = nil
            clipView = nil
            documentView = nil
            lastSnapshot = nil
        }

        func emitCurrentSnapshotIfPossible() {
            guard let scrollView,
                  let documentView = scrollView.documentView
            else { return }

            let clipView = scrollView.contentView
            let snapshot = ScrollGeometrySnapshot(
                contentOffsetY: clipView.bounds.origin.y,
                contentHeight: documentView.frame.height,
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
