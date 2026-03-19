import SwiftUI

/// A lightweight `NSViewRepresentable` that enables window dragging from any
/// SwiftUI region by calling `window?.performDrag(with:)` on mouse-down.
///
/// This bypasses the `NonDraggableContainerView` hierarchy (which sets
/// `mouseDownCanMoveWindow` to `false` on the hosting view) by initiating the
/// drag directly from the event.
struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> DraggableView {
        DraggableView()
    }

    func updateNSView(_ nsView: DraggableView, context: Context) {}

    final class DraggableView: NSView {
        override var mouseDownCanMoveWindow: Bool { true }

        override func mouseDown(with event: NSEvent) {
            window?.performDrag(with: event)
        }
    }
}
