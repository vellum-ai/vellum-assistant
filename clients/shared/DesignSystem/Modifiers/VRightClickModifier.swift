#if os(macOS)
import SwiftUI
import AppKit

// MARK: - Right-click detection

/// Detects right-click and Ctrl-click (secondary click) events on a view and
/// reports the screen-coordinate position. Uses an NSEvent local monitor so it
/// does not interfere with left-click, hover, or drag gestures.
///
/// The monitor is scoped to this view's window — events from other windows
/// are ignored and passed through.
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
        private var rightClickMonitor: Any?
        private var ctrlClickMonitor: Any?

        init(action: @escaping (CGPoint) -> Void) {
            self.action = action
            super.init(frame: .zero)
        }

        required init?(coder: NSCoder) { fatalError() }

        private func handleSecondaryClick(_ event: NSEvent) -> NSEvent? {
            guard let myWindow = self.window else { return event }
            // Only handle events from this view's window
            guard event.window === myWindow else { return event }
            let locationInView = self.convert(event.locationInWindow, from: nil)
            if self.bounds.contains(locationInView) {
                let screenPoint = myWindow.convertPoint(toScreen: event.locationInWindow)
                self.action(screenPoint)
                return nil
            }
            return event
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            removeMonitors()
            guard window != nil else { return }

            // Monitor right-click
            rightClickMonitor = NSEvent.addLocalMonitorForEvents(matching: .rightMouseDown) { [weak self] event in
                self?.handleSecondaryClick(event) ?? event
            }

            // Monitor Ctrl-click (standard macOS secondary click fallback)
            ctrlClickMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
                guard event.modifierFlags.contains(.control) else { return event }
                return self?.handleSecondaryClick(event) ?? event
            }
        }

        private func removeMonitors() {
            rightClickMonitor.flatMap(NSEvent.removeMonitor)
            rightClickMonitor = nil
            ctrlClickMonitor.flatMap(NSEvent.removeMonitor)
            ctrlClickMonitor = nil
        }

        override func removeFromSuperview() {
            removeMonitors()
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
