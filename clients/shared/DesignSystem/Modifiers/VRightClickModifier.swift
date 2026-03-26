#if os(macOS)
import SwiftUI
import AppKit

// MARK: - Right-click detection

/// Detects right-click (secondary click) events on a view and reports the
/// screen-coordinate position. Uses an NSEvent local monitor so it does not
/// interfere with left-click, hover, or drag gestures.
private struct RightClickDetector: NSViewRepresentable {
    let action: (CGPoint) -> Void

    func makeNSView(context: Context) -> RightClickNSView {
        RightClickNSView(action: action)
    }

    func updateNSView(_ nsView: RightClickNSView, context: Context) {
        nsView.action = action
    }

    class RightClickNSView: NSView {
        var action: (CGPoint) -> Void
        private var monitor: Any?

        init(action: @escaping (CGPoint) -> Void) {
            self.action = action
            super.init(frame: .zero)
        }

        required init?(coder: NSCoder) { fatalError() }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            monitor.flatMap(NSEvent.removeMonitor)
            monitor = nil
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .rightMouseDown) { [weak self] event in
                guard let self, let window = self.window else { return event }
                let locationInView = self.convert(event.locationInWindow, from: nil)
                if self.bounds.contains(locationInView) {
                    let screenPoint = window.convertPoint(toScreen: event.locationInWindow)
                    self.action(screenPoint)
                    return nil
                }
                return event
            }
        }

        override func removeFromSuperview() {
            monitor.flatMap(NSEvent.removeMonitor)
            monitor = nil
            super.removeFromSuperview()
        }

        // Never intercept hit testing — left clicks, hover, and drag pass through.
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}

// MARK: - View extension

public extension View {
    /// Calls `action` with the screen-coordinate click position when the user
    /// right-clicks (secondary clicks) anywhere on this view.
    func onRightClick(perform action: @escaping (_ screenPoint: CGPoint) -> Void) -> some View {
        background {
            RightClickDetector(action: action)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
#endif
